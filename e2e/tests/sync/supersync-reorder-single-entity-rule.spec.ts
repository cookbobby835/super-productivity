import type { Page } from '@playwright/test';
import type { CompactOperationLogEntry } from '../../../src/app/op-log/persistence/compact/compact-operation.types';
import { expect, test } from '../../fixtures/supersync.fixture';
import { NotePage } from '../../pages/note.page';
import { TagPage } from '../../pages/tag.page';
import {
  closeClient,
  createSimulatedClient,
  createTestUser,
  getSuperSyncConfig,
  type SimulatedE2EClient,
} from '../../utils/supersync-helpers';
import { waitForAppReady } from '../../utils/waits';

/**
 * One structural rule: a reorder writes one ordered list per context; a
 * concurrent single-entity edit that keeps the entity's identity and whose
 * reducer writes neither that list nor its membership commutes with it.
 *
 * Both crossing actions come from the real UI; only the baseline is seeded
 * through the store. The strict sync helper fails on the whole-dataset
 * "Sync: Conflicting Data" dialog and never picks Keep local or Keep remote.
 * Either device's order may win; both devices must converge and the edit and
 * the unrelated work of both devices must survive.
 */
type Row = CompactOperationLogEntry;
type Entity = Record<string, unknown>;
interface Slice {
  ids: string[];
  entities: Record<string, Entity>;
}
interface Snapshot {
  /** The ordered list the reorder writes, restricted to the fixture's ids. */
  order: string[];
  /** A second list (notes: the other note list) or the full list with foreign slots. */
  other: string[];
  entities: Record<string, Entity>;
  tasks: string[];
}
type ListName = 'project notes' | 'Today notes' | 'tag notes' | 'sections' | 'habits';
type EditName =
  | 'pin'
  | 'unpin'
  | 'lock'
  | 'unlock'
  | 'content'
  | 'collapse'
  | 'expand'
  | 'settings'
  | 'disable';
interface Crossing {
  list: ListName;
  edit: EditName;
}

const PROJECT = 'INBOX_PROJECT';
const EDITED = 'edited concurrently';
const COUNT_DAY = '2026-09-20';

const dispatch = async (
  page: Page,
  actions: Record<string, unknown>[],
): Promise<void> => {
  await page.evaluate(async (items) => {
    const store = (
      window as unknown as {
        __e2eTestHelpers: { store: { dispatch: (a: unknown) => void } };
      }
    ).__e2eTestHelpers.store;
    for (const item of items) store.dispatch(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }, actions);
};

const persistent = (
  type: string,
  entityType: string,
  entityId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> => ({
  type,
  ...payload,
  meta: { isPersistent: true, entityType, entityId, opType: 'CRT' },
});

const readSlices = (
  page: Page,
): Promise<{
  note: Slice & { todayOrder: string[] };
  projectNoteIds: string[];
  section: Slice;
  simpleCounter: Slice;
  tag: Slice;
  tasks: string[];
}> =>
  page.evaluate((projectId) => {
    type State = {
      note: Slice & { todayOrder: string[] };
      projects: { entities: Record<string, { noteIds: string[] }> };
      section: Slice;
      simpleCounter: Slice;
      tag: Slice;
      tasks: { entities: Record<string, { title: string }> };
    };
    let state!: State;
    (
      window as unknown as {
        __e2eTestHelpers: {
          store: { subscribe: (fn: (s: State) => void) => { unsubscribe: () => void } };
        };
      }
    ).__e2eTestHelpers.store
      .subscribe((s) => (state = s))
      .unsubscribe();
    return {
      note: state.note,
      projectNoteIds: state.projects.entities[projectId].noteIds,
      section: state.section,
      simpleCounter: state.simpleCounter,
      tag: state.tag,
      tasks: Object.values(state.tasks.entities)
        .map((t) => t.title)
        .sort(),
    };
  }, PROJECT);

const snapshot = async (page: Page, list: ListName, ids: string[]): Promise<Snapshot> => {
  const s = await readSlices(page);
  const pick = (entities: Record<string, Entity>): Record<string, Entity> =>
    Object.fromEntries(ids.map((id) => [id, entities[id]]));
  if (list === 'sections') {
    return {
      order: s.section.ids.filter((id) => ids.includes(id)),
      other: s.section.ids,
      entities: pick(s.section.entities),
      tasks: s.tasks,
    };
  }
  if (list === 'habits') {
    return {
      order: s.simpleCounter.ids.filter((id) => ids.includes(id)),
      other: s.simpleCounter.ids,
      entities: pick(s.simpleCounter.entities),
      tasks: s.tasks,
    };
  }
  const project = s.projectNoteIds.filter((id) => ids.includes(id));
  const today = s.note.todayOrder.filter((id) => ids.includes(id));
  return {
    order: list === 'project notes' ? project : today,
    other: list === 'project notes' ? today : project,
    entities: pick(s.note.entities),
    tasks: s.tasks,
  };
};

const rows = (page: Page): Promise<Row[]> =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('SUP_OPS');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise<Row[]>((resolve, reject) => {
        const r = db.transaction('ops').objectStore('ops').getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  });
const pending = (entries: Row[]): Row[] =>
  entries.filter((r) => r.source === 'local' && !r.syncedAt && !r.rejectedAt);
const fullStateOps = (entries: Row[]): string[] =>
  entries
    .filter((r) => ['REPAIR', 'SYNC_IMPORT', 'BACKUP_IMPORT'].includes(r.op.o))
    .map((r) => r.op.id)
    .sort();

/** Strict: a real successful download, then no dialog/error and nothing pending. */
const syncOutcome = async (client: SimulatedE2EClient): Promise<string> => {
  const downloaded = client.page.waitForResponse(
    (r) => r.url().includes('/api/sync/ops') && r.request().method() === 'GET',
  );
  await client.sync.clickSyncBtn();
  expect((await downloaded).ok()).toBe(true);
  let outcome = 'pending';
  await expect
    .poll(
      async () => {
        outcome = (await client.sync.conflictDialog.isVisible())
          ? 'conflict-dialog'
          : (await client.sync.hasSyncError())
            ? 'error'
            : !(await client.sync.syncSpinner.isVisible()) &&
                (await client.sync.syncCheckIcon
                  .filter({ hasText: /^done_all$/ })
                  .isVisible())
              ? 'in-sync'
              : 'pending';
        return outcome;
      },
      { timeout: 30000 },
    )
    .not.toBe('pending');
  return outcome;
};
const sync = async (client: SimulatedE2EClient): Promise<void> => {
  expect(await syncOutcome(client)).toBe('in-sync');
};

// ---------------------------------------------------------------------------
// Real UI actions
// ---------------------------------------------------------------------------

/** Drag a real section header handle above another one (y-locked CDK list). */
const dragAbove = async (
  page: Page,
  source: ReturnType<Page['locator']>,
  target: ReturnType<Page['locator']>,
): Promise<void> => {
  await source.hover();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('Drag targets missing');
  const halfFromWidth = from.width / 2;
  const halfFromHeight = from.height / 2;
  const halfToWidth = to.width / 2;
  const x = from.x + halfFromWidth;
  const y = from.y + halfFromHeight;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 8, { steps: 3 });
  await expect(page.locator('.cdk-drag-preview')).toBeVisible();
  await page.mouse.move(to.x + halfToWidth, to.y + 4, { steps: 20 });
  await page.mouse.up();
  await expect(page.locator('.cdk-drag-preview')).toBeHidden();
};

const openNotes = async (page: Page, route: string): Promise<void> => {
  await page.goto(`/#/${route}/tasks`);
  await waitForAppReady(page, { ensureRoute: false });
  await new NotePage(page).ensureNotesVisible();
  await expect(page.locator('notes .notes')).toBeVisible();
};
const visibleNotes = (page: Page): Promise<string[]> =>
  page
    .locator('notes .notes > div[id^="n-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.id.slice(2)));

const noteRoute = (list: ListName, tagId: string): string =>
  list === 'project notes'
    ? `project/${PROJECT}`
    : list === 'Today notes'
      ? 'tag/TODAY'
      : `tag/${tagId}`;

const dragNotes = async (page: Page, route: string): Promise<string[]> => {
  await openNotes(page, route);
  const [first, second, ...rest] = await visibleNotes(page);
  // Same gesture as supersync-note-today-pin-reorder.spec.ts.
  const source = page.locator(`#n-${first} .handle-drag`);
  const target = page.locator(`#n-${second}`);
  await source.hover();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('Note drag targets missing');
  const halfSourceWidth = from.width / 2;
  const halfSourceHeight = from.height / 2;
  const halfTargetWidth = to.width / 2;
  const x = from.x + halfSourceWidth;
  const y = from.y + halfSourceHeight;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 8);
  await expect(page.locator('.cdk-drag-preview')).toBeVisible();
  await page.mouse.move(to.x + halfTargetWidth, to.y + to.height - 4, { steps: 20 });
  await page.mouse.up();
  await expect(page.locator('.cdk-drag-preview')).toBeHidden();
  const expected = [second, first, ...rest];
  await expect.poll(() => visibleNotes(page)).toEqual(expected);
  return expected;
};

const editNote = async (page: Page, id: string, edit: EditName): Promise<void> => {
  await openNotes(page, `project/${PROJECT}`);
  const note = page.locator(`#n-${id}`);
  await note.hover();
  if (edit === 'pin' || edit === 'unpin') {
    await note
      .locator(
        edit === 'pin'
          ? 'button:has(mat-icon:text-is("wb_sunny"))'
          : 'button:has(mat-icon[data-mat-icon-name="remove_today"])',
      )
      .click();
  } else if (edit === 'lock' || edit === 'unlock') {
    await note.locator('button:has(mat-icon:text-is("more_vert"))').click();
    await page
      .locator('.mat-mdc-menu-content button')
      .filter({
        has: page.locator(
          `mat-icon:text-is("${edit === 'lock' ? 'lock_open' : 'lock'}")`,
        ),
      })
      .click();
  } else {
    await new NotePage(page).editNote(note.locator('note'), EDITED);
  }
};

const openProjectWorkView = async (page: Page): Promise<void> => {
  await page.goto(`/#/project/${PROJECT}/tasks`);
  await waitForAppReady(page, { ensureRoute: false });
  await expect(page.locator('.sections-wrapper')).toBeVisible();
};
const sectionHeader = (page: Page, title: string): ReturnType<Page['locator']> =>
  page
    .locator('.section-container')
    .filter({ has: page.locator('.collapsible-title', { hasText: title }) });

const dragSections = async (page: Page, ids: string[]): Promise<void> => {
  await openProjectWorkView(page);
  // Drag Beta's real header handle above Alpha.
  await dragAbove(
    page,
    sectionHeader(page, ids[1]).locator('.collapsible-title.is-drag-handle'),
    sectionHeader(page, ids[0]).locator('.collapsible-title.is-drag-handle'),
  );
  await expect
    .poll(async () =>
      (await readSlices(page)).section.ids.filter((id) =>
        [ids[0], ids[1], ids[2]].includes(id),
      ),
    )
    .toEqual([ids[1], ids[0], ids[2]]);
};
const toggleSection = async (page: Page, id: string): Promise<void> => {
  await openProjectWorkView(page);
  await sectionHeader(page, id).locator('.collapsible-expand-icon').click();
};

const openHabits = async (page: Page): Promise<void> => {
  await page.goto('/#/habits');
  await waitForAppReady(page, { routeRegex: /#\/habits/, selector: '.habit-grid' });
  await expect(page.locator('.habit-row')).toHaveCount(3);
};
const habitOrder = (page: Page): Promise<string[]> =>
  page.locator('.habit-row .habit-name').allTextContents();
/** Same CDK gesture as the reorder wedge spec, including its enabled-only footprint. */
const dragHabits = async (page: Page): Promise<void> => {
  await openHabits(page);
  const before = await habitOrder(page);
  const from = await page.locator('.habit-row').last().boundingBox();
  const to = await page.locator('.habit-row').first().boundingBox();
  if (!from || !to) throw new Error('Habit drag targets missing');
  const halfHeight = from.height / 2;
  const centerY = from.y + halfHeight;
  await page.mouse.move(from.x + 30, centerY);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, centerY - 10, { steps: 3 });
  await expect(page.locator('.cdk-drag-preview')).toBeVisible();
  await page.mouse.move(to.x + 30, to.y + 5, { steps: 25 });
  await page.mouse.up();
  await expect(page.locator('.cdk-drag-preview')).toBeHidden();
  await expect.poll(() => habitOrder(page)).not.toEqual(before);
};
const editHabitSettings = async (
  page: Page,
  title: string,
  edit: EditName,
): Promise<void> => {
  await openHabits(page);
  await page
    .locator('.habit-row .habit-title')
    .filter({ has: page.getByText(title, { exact: true }) })
    .click();
  const dialog = page.locator('dialog-simple-counter-edit-settings');
  await expect(dialog).toBeVisible();
  if (edit === 'disable') {
    const enabled = dialog.getByRole('checkbox', { name: 'Enabled' });
    await expect(enabled).toBeChecked();
    await enabled.uncheck();
  } else {
    await dialog.getByRole('textbox', { name: 'Title' }).fill(EDITED);
  }
  await dialog.getByRole('button', { name: /Save/ }).click();
  await expect(dialog).toBeHidden();
};

// ---------------------------------------------------------------------------
// Fixture seeds
// ---------------------------------------------------------------------------

const noteSeeds = (ids: string[], edit: EditName): Record<string, unknown>[] =>
  [...ids.entries()].reverse().map(([index, id]) =>
    persistent('[Note] Add Note', 'NOTE', id, {
      note: {
        id,
        projectId: index === 3 ? null : PROJECT,
        // The target starts unpinned only when the crossing pins it.
        isPinnedToToday: index !== 0 || edit !== 'pin',
        content: `Synthetic note ${index}`,
        ...(index === 0 && edit === 'unlock' ? { isLock: true } : {}),
        created: 100,
        modified: 100,
      },
      isPreventFocus: true,
    }),
  );

const sectionSeeds = (ids: string[], edit: EditName): Record<string, unknown>[] =>
  // A foreign-context section sits between Alpha and Beta in section.ids.
  [ids[0], ids[3], ids[1], ids[2]].map((id) =>
    persistent('[Section] Add Section', 'SECTION', id, {
      section: {
        id,
        title: id,
        contextId: id === ids[3] ? 'TODAY' : PROJECT,
        contextType: id === ids[3] ? 'TAG' : 'PROJECT',
        taskIds: [],
        ...(id === ids[0] ? { isExpanded: edit !== 'expand' } : {}),
      },
    }),
  );

const habitSeeds = (ids: string[]): Record<string, unknown>[] =>
  ids.map((id, index) =>
    persistent('[SimpleCounter] Add SimpleCounter', 'SIMPLE_COUNTER', id, {
      simpleCounter: {
        id,
        title: id,
        // ids[1] is disabled: outside the enabled-only drag, its slot must stay.
        isEnabled: index !== 1,
        icon: null,
        // A type the receiver's default-field repair could not restore.
        type: index === 0 ? 'StopWatch' : 'ClickCounter',
        countOnDay: Object.fromEntries([[COUNT_DAY, index + 1]]),
        isOn: false,
      },
    }),
  );

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

const crossings: Crossing[] = [
  // 1. Pin/unpin write todayOrder, not project.noteIds; unpin is the
  //    membership change the Today reorder already treats as commuting.
  { list: 'project notes', edit: 'pin' },
  { list: 'project notes', edit: 'unpin' },
  { list: 'Today notes', edit: 'unpin' },
  // 2. In-place note fields.
  { list: 'project notes', edit: 'lock' },
  { list: 'Today notes', edit: 'unlock' },
  // 3. Section expansion is an in-place field.
  { list: 'sections', edit: 'collapse' },
  { list: 'sections', edit: 'expand' },
  // 4. Habit settings, including disabling a listed habit.
  { list: 'habits', edit: 'settings' },
  { list: 'habits', edit: 'disable' },
  // 5. A non-TODAY tag view shows and reorders note.todayOrder too.
  { list: 'tag notes', edit: 'content' },
];

const orderCode = (list: ListName): string =>
  list === 'sections' ? 'S4' : list === 'habits' ? 'SM' : 'NO';
const editCode = (list: ListName): string =>
  list === 'sections' ? 'S3' : list === 'habits' ? 'SU' : 'NU';

for (const crossing of crossings) {
  for (const pendingOrder of [true, false]) {
    for (const incomingNewer of [true, false]) {
      const name =
        `@supersync reorder rule: ${crossing.list} vs ${crossing.edit}` +
        ` / local-${pendingOrder ? 'order' : 'edit'}` +
        ` / incoming-${incomingNewer ? 'newer' : 'older'}`;
      test(name, async ({ browser, baseURL, testRunId }, testInfo) => {
        test.setTimeout(240000);
        const clients: SimulatedE2EClient[] = [];
        const logs: string[] = [];
        const evidence: Record<string, unknown> = {
          crossing,
          pendingOrder,
          incomingNewer,
        };
        const { list, edit } = crossing;
        try {
          const config = getSuperSyncConfig(await createTestUser(testRunId));
          const makeClient = async (clientName: string): Promise<SimulatedE2EClient> => {
            const client = await createSimulatedClient(
              browser,
              baseURL!,
              clientName,
              testRunId,
            );
            clients.push(client);
            client.page.on('console', (m) => logs.push(`${clientName}: ${m.text()}`));
            await client.sync.setupSuperSync(config);
            await client.page.addInitScript(() => {
              const flags = window as unknown as Record<string, unknown>;
              flags.__SP_E2E_BLOCK_AUTO_SYNC = true;
              flags.__SP_E2E_BLOCK_IMMEDIATE_UPLOAD = true;
              flags.__SP_E2E_BLOCK_WS_DOWNLOAD = true;
            });
            return client;
          };

          const a = await makeClient('A');
          const ids = (
            list === 'sections'
              ? ['Alpha', 'Beta', 'Untouched', 'Foreign']
              : list === 'habits'
                ? ['target', 'disabled', 'sibling', 'untouched']
                : ['target', 'sibling', 'witness', 'today-only']
          ).map((id) => `${id}-${testRunId}`);
          let tagId = '';
          if (list === 'tag notes') {
            // Any user tag view lists note.todayOrder in its notes panel.
            const tagTitle = `Reorder tag ${testRunId}`;
            await new TagPage(a.page).createTag(tagTitle);
            const findTag = async (): Promise<string | undefined> => {
              const { tag } = await readSlices(a.page);
              return tag.ids.find((id) => tag.entities[id]?.title === tagTitle);
            };
            await expect.poll(findTag).toBeTruthy();
            tagId = (await findTag())!;
          }
          await dispatch(
            a.page,
            list === 'sections'
              ? sectionSeeds(ids, edit)
              : list === 'habits'
                ? habitSeeds(ids)
                : noteSeeds(ids, edit),
          );
          await sync(a);
          const b = await makeClient('B');
          await sync(b);
          await sync(a);
          const before = await snapshot(a.page, list, ids);
          expect(await snapshot(b.page, list, ids)).toEqual(before);
          const fullStateBefore = new Set([
            ...fullStateOps(await rows(a.page)),
            ...fullStateOps(await rows(b.page)),
          ]);
          // Unrelated work on both devices must survive the crossing.
          await a.workView.addTask(`local witness ${testRunId}`);
          await b.workView.addTask(`remote witness ${testRunId}`);

          const orderClient = pendingOrder ? a : b;
          const editClient = pendingOrder ? b : a;
          const perform = async (client: SimulatedE2EClient): Promise<void> => {
            const isOrder = client === orderClient;
            if (isOrder) {
              if (list === 'sections') await dragSections(client.page, ids);
              else if (list === 'habits') await dragHabits(client.page);
              else await dragNotes(client.page, noteRoute(list, tagId));
            } else if (list === 'sections') {
              await toggleSection(client.page, ids[0]);
            } else if (list === 'habits') {
              await editHabitSettings(client.page, ids[0], edit);
            } else {
              await editNote(client.page, ids[0], edit);
            }
            const code = isOrder ? orderCode(list) : editCode(list);
            await expect
              .poll(async () =>
                pending(await rows(client.page)).filter((r) => r.op.a === code),
              )
              .toHaveLength(1);
          };
          // Change real UI action order, not timestamps or stored rows.
          await perform(incomingNewer ? a : b);
          await perform(incomingNewer ? b : a);

          const order = pending(await rows(orderClient.page)).find(
            (r) => r.op.a === orderCode(list),
          )!.op;
          const update = pending(await rows(editClient.page)).find(
            (r) => r.op.a === editCode(list),
          )!.op;
          expect(order).toMatchObject({ o: 'MOV', d: order.ds![0] });
          expect(update).toMatchObject({ o: 'UPD', d: ids[0], ds: [ids[0]] });
          // The edited entity is a declared, non-primary id of the reorder.
          expect(order.ds).toContain(ids[0]);
          expect(order.ds!.length).toBeGreaterThan(1);
          if (list === 'tag notes') {
            expect(order.p).toMatchObject({
              actionPayload: { activeContextType: 'TAG', activeContextId: tagId },
            });
          }
          const local = pendingOrder ? order : update;
          const remote = pendingOrder ? update : order;
          expect(remote.t > local.t).toBe(incomingNewer);
          const keys = new Set([...Object.keys(local.v), ...Object.keys(remote.v)]);
          expect([...keys].some((k) => (local.v[k] || 0) > (remote.v[k] || 0))).toBe(
            true,
          );
          expect([...keys].some((k) => (local.v[k] || 0) < (remote.v[k] || 0))).toBe(
            true,
          );
          const edited = await snapshot(editClient.page, list, ids);
          const reordered = await snapshot(orderClient.page, list, ids);
          expect(edited.entities[ids[0]]).not.toEqual(before.entities[ids[0]]);
          evidence.beforeCrossing = { order, update, edited, reordered };

          // B uploads first; A resolves while its own crossing op is pending.
          await sync(b);
          const outcome = await syncOutcome(a);
          evidence.outcome = outcome;
          if (outcome !== 'in-sync') {
            evidence.safetyStop = logs.filter((l) =>
              l.includes('SYNC_MULTI_ENTITY_UNSUPPORTED'),
            );
            // The manual-sync dialog can follow the error icon; record it, never answer it.
            await a.sync.conflictDialog
              .waitFor({ state: 'visible', timeout: 5000 })
              .catch(() => undefined);
            evidence.dialog = (await a.sync.conflictDialog.isVisible())
              ? await a.sync.conflictDialog.innerText()
              : null;
          }
          expect(
            outcome,
            `must sync without the safety stop: ${JSON.stringify(evidence.safetyStop ?? [])}`,
          ).toBe('in-sync');
          await sync(b);
          await sync(a);

          const final = await snapshot(a.page, list, ids);
          expect(await snapshot(b.page, list, ids)).toEqual(final);
          // The edit survives on the entity, every other entity is untouched.
          expect(final.entities).toEqual({
            ...before.entities,
            [ids[0]]: edited.entities[ids[0]],
          });
          // One converged, unique order over the same members (either winner).
          expect(new Set(final.order).size).toBe(final.order.length);
          expect([...final.order].sort()).toEqual(
            [...(list === 'Today notes' ? edited.order : before.order)].sort(),
          );
          if (list.endsWith('notes')) {
            expect(new Set(final.other).size).toBe(final.other.length);
            expect([...final.other].sort()).toEqual(
              [...(list === 'project notes' ? edited.other : before.other)].sort(),
            );
          } else {
            // Foreign-context / disabled slots keep their absolute position.
            const fixed = ids[list === 'sections' ? 3 : 1];
            expect(final.other.indexOf(fixed)).toBe(before.other.indexOf(fixed));
          }
          if (list === 'habits') expect(final.entities[ids[0]].type).toBe('StopWatch');
          expect(final.tasks).toEqual(
            expect.arrayContaining([
              expect.stringContaining(`local witness ${testRunId}`),
              expect.stringContaining(`remote witness ${testRunId}`),
            ]),
          );

          for (const client of [a, b]) {
            const entries = await rows(client.page);
            expect(pending(entries)).toEqual([]);
            expect(fullStateOps(entries).every((id) => fullStateBefore.has(id))).toBe(
              true,
            );
            await client.page.reload();
            await waitForAppReady(client.page, { ensureRoute: false });
            expect(await snapshot(client.page, list, ids)).toEqual(final);
            await sync(client);
          }
          const fresh = await makeClient('Fresh');
          await sync(fresh);
          expect(await snapshot(fresh.page, list, ids)).toEqual(final);
          expect(
            fullStateOps(await rows(fresh.page)).every((id) => fullStateBefore.has(id)),
          ).toBe(true);
        } finally {
          await testInfo.attach('evidence', {
            body: JSON.stringify(evidence, null, 2),
            contentType: 'application/json',
          });
          for (const client of clients) await closeClient(client);
        }
      });
    }
  }
}
