const test = require('node:test');
const assert = require('node:assert/strict');

const MergeCore = require('../app/merge-core.js');
const {
  createEmptyDb,
  insertRow,
  countRows,
  locationDefaults,
  userMarkDefaults,
  noteDefaults
} = require('./helpers.js');

function fkProblems(db) {
  return MergeCore.queryAll(db, 'PRAGMA foreign_key_check');
}

test('mergeNotes: merges only new notes, skips duplicates by Guid, never reuses source numeric ids', async () => {
  const target = await createEmptyDb();
  const source = await createEmptyDb();

  // Nota que já existe nos dois arquivos (mesmo Guid) — não deve duplicar.
  insertRow(target, 'Location', locationDefaults({ LocationId: 1, KeySymbol: 'w', DocumentId: 100 }));
  insertRow(target, 'Note', noteDefaults({ NoteId: 1, Guid: 'dup-guid', LocationId: 1, Title: 'Já tinha' }));

  insertRow(source, 'Location', locationDefaults({ LocationId: 1, KeySymbol: 'w', DocumentId: 100 }));
  insertRow(source, 'Note', noteDefaults({ NoteId: 1, Guid: 'dup-guid', LocationId: 1, Title: 'Já tinha' }));

  // Nota nova, com Location/UserMark/Tag próprios (ids numéricos diferentes de propósito).
  insertRow(source, 'Location', locationDefaults({ LocationId: 50, Title: 'Artigo novo' }));
  insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: 77, LocationId: 50, UserMarkGuid: 'um-new' }));
  insertRow(source, 'BlockRange', { BlockRangeId: 1, BlockType: 1, Identifier: 1, StartToken: 0, EndToken: 5, UserMarkId: 77 });
  insertRow(source, 'Note', noteDefaults({ NoteId: 2, Guid: 'new-guid', UserMarkId: 77, LocationId: 50, Title: 'Nota nova', Content: 'conteúdo' }));
  insertRow(source, 'Tag', { TagId: 5, Type: 1, Name: 'Favoritos' });
  insertRow(source, 'TagMap', { TagMapId: 1, PlaylistItemId: null, LocationId: null, NoteId: 2, TagId: 5, Position: 0 });

  const report = MergeCore.mergeNotes(target, source);

  assert.equal(report.beforeCount, 1);
  assert.equal(report.added.length, 1);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.added[0].title, 'Nota nova');

  // A nota nova foi inserida com ids RESOLVIDOS no destino, não os brutos da origem (50/77).
  const insertedNote = MergeCore.queryOne(target, "SELECT * FROM Note WHERE Guid='new-guid'");
  assert.ok(insertedNote);
  assert.notEqual(insertedNote.LocationId, 50);
  assert.notEqual(insertedNote.UserMarkId, 77);

  const insertedMark = MergeCore.queryOne(target, "SELECT * FROM UserMark WHERE UserMarkGuid='um-new'");
  assert.ok(insertedMark);
  assert.equal(insertedMark.UserMarkId, insertedNote.UserMarkId);

  assert.equal(countRows(target, 'BlockRange'), 1);
  assert.equal(countRows(target, 'Tag'), 1);
  assert.equal(countRows(target, 'TagMap'), 1);

  assert.deepEqual(fkProblems(target), []);
});

test('mergeNotes ("Importar apenas notas"): never imports a pure highlight without a Note', async () => {
  const target = await createEmptyDb();
  const source = await createEmptyDb();

  // Grifo puro (sem nenhuma Note apontando para ele) — não deve entrar no destino.
  insertRow(source, 'Location', locationDefaults({ LocationId: 1, Title: 'Artigo com grifo solto' }));
  insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: 1, LocationId: 1, UserMarkGuid: 'solto-um' }));
  insertRow(source, 'BlockRange', { BlockRangeId: 1, BlockType: 1, Identifier: 1, StartToken: 0, EndToken: 5, UserMarkId: 1 });

  // Grifo COM nota, na mesma origem — esse sim deve entrar (via a nota).
  insertRow(source, 'Location', locationDefaults({ LocationId: 2, Title: 'Artigo com nota' }));
  insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: 2, LocationId: 2, UserMarkGuid: 'com-nota-um' }));
  insertRow(source, 'BlockRange', { BlockRangeId: 2, BlockType: 1, Identifier: 1, StartToken: 0, EndToken: 5, UserMarkId: 2 });
  insertRow(source, 'Note', noteDefaults({ NoteId: 1, Guid: 'note-guid', UserMarkId: 2, LocationId: 2, Title: 'Comentário' }));

  const report = MergeCore.mergeNotes(target, source);

  assert.equal(report.added.length, 1);
  assert.equal(countRows(target, 'Note'), 1);
  assert.equal(countRows(target, 'UserMark'), 1, 'só o UserMark ligado à nota deve ser copiado');

  const importedMark = MergeCore.queryOne(target, 'SELECT * FROM UserMark LIMIT 1');
  assert.equal(importedMark.UserMarkGuid, 'com-nota-um');

  const soltoStillAbsent = MergeCore.queryOne(target, "SELECT * FROM UserMark WHERE UserMarkGuid='solto-um'");
  assert.equal(soltoStillAbsent, null);

  assert.deepEqual(fkProblems(target), []);
});

test('mergeSelectedHighlights: imports a "pure" highlight (no note) correctly', async () => {
  const target = await createEmptyDb();
  const source = await createEmptyDb();

  insertRow(source, 'Location', locationDefaults({ LocationId: 10, BookNumber: 1, ChapterNumber: 2 }));
  insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: 1, LocationId: 10, UserMarkGuid: 'pure-um' }));
  insertRow(source, 'BlockRange', { BlockRangeId: 1, BlockType: 1, Identifier: 1, StartToken: 0, EndToken: 10, UserMarkId: 1 });
  // Nenhuma Note referenciando esse UserMark — grifo "puro".

  const groups = MergeCore.listHighlightGroups(source);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 1);
  assert.equal(groups[0].label, 'Livro 1, capítulo 2');

  const report = MergeCore.mergeSelectedHighlights(target, source, groups[0].locationIds);

  assert.equal(report.userMarksAdded, 1);
  assert.equal(report.userMarksReused, 0);
  assert.equal(report.notesAdded.length, 0);
  assert.equal(report.notesSkipped, 0);

  assert.equal(countRows(target, 'UserMark'), 1);
  assert.equal(countRows(target, 'BlockRange'), 1);
  assert.equal(countRows(target, 'Location'), 1);
  assert.equal(countRows(target, 'Note'), 0, 'nenhuma nota deve ser criada para um grifo puro');

  assert.deepEqual(fkProblems(target), []);
});

test('mergeSelectedHighlights: also copies the Note attached to a selected highlight, resolving ids', async () => {
  const target = await createEmptyDb();
  const source = await createEmptyDb();

  insertRow(source, 'Location', locationDefaults({ LocationId: 50, Title: 'Artigo X', KeySymbol: 'w', DocumentId: 200 }));
  insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: 99, LocationId: 50, UserMarkGuid: 'um-with-note' }));
  insertRow(source, 'BlockRange', { BlockRangeId: 1, BlockType: 1, Identifier: 1, StartToken: 0, EndToken: 20, UserMarkId: 99 });
  insertRow(source, 'Note', noteDefaults({ NoteId: 1, Guid: 'note-with-mark', UserMarkId: 99, LocationId: 50, Title: 'Comentário', Content: 'texto' }));
  insertRow(source, 'Tag', { TagId: 1, Type: 1, Name: 'Estudo' });
  insertRow(source, 'TagMap', { TagMapId: 1, PlaylistItemId: null, LocationId: null, NoteId: 1, TagId: 1, Position: 0 });

  const groups = MergeCore.listHighlightGroups(source);
  assert.equal(groups[0].label, 'Artigo X');

  const report = MergeCore.mergeSelectedHighlights(target, source, groups[0].locationIds);

  assert.equal(report.userMarksAdded, 1);
  assert.equal(report.notesAdded.length, 1);
  assert.equal(report.notesAdded[0].title, 'Comentário');

  const insertedNote = MergeCore.queryOne(target, "SELECT * FROM Note WHERE Guid='note-with-mark'");
  assert.ok(insertedNote);
  assert.notEqual(insertedNote.UserMarkId, 99, 'não deve reaproveitar o UserMarkId numérico da origem');
  assert.notEqual(insertedNote.LocationId, 50, 'não deve reaproveitar o LocationId numérico da origem');

  assert.equal(countRows(target, 'Tag'), 1);
  assert.equal(countRows(target, 'TagMap'), 1);
  assert.deepEqual(fkProblems(target), []);
});

test('mergeSelectedHighlights: dedups UserMark by Guid and Location by natural key, even with different numeric ids', async () => {
  const target = await createEmptyDb();
  const source = await createEmptyDb();

  // Destino já tem esse grifo, mas com LocationId/UserMarkId numéricos DIFERENTES dos da origem.
  insertRow(target, 'Location', locationDefaults({ LocationId: 5, Title: 'Artigo Y' }));
  insertRow(target, 'UserMark', userMarkDefaults({ UserMarkId: 5, LocationId: 5, UserMarkGuid: 'shared-um' }));

  insertRow(source, 'Location', locationDefaults({ LocationId: 999, Title: 'Artigo Y' }));
  insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: 999, LocationId: 999, UserMarkGuid: 'shared-um' }));
  insertRow(source, 'BlockRange', { BlockRangeId: 1, BlockType: 1, Identifier: 1, StartToken: 0, EndToken: 5, UserMarkId: 999 });

  const groups = MergeCore.listHighlightGroups(source);
  const report = MergeCore.mergeSelectedHighlights(target, source, groups[0].locationIds);

  assert.equal(report.userMarksAdded, 0);
  assert.equal(report.userMarksReused, 1);
  assert.equal(countRows(target, 'Location'), 1, 'não deve criar uma Location duplicada com a mesma chave natural');
  assert.equal(countRows(target, 'UserMark'), 1, 'não deve duplicar o UserMark existente');
  assert.deepEqual(fkProblems(target), []);
});

test('mergeSelectedHighlights: running the same selection twice is idempotent', async () => {
  const target = await createEmptyDb();
  const source = await createEmptyDb();

  insertRow(source, 'Location', locationDefaults({ LocationId: 1, Title: 'Artigo Z' }));
  insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: 1, LocationId: 1, UserMarkGuid: 'idem-um' }));
  insertRow(source, 'BlockRange', { BlockRangeId: 1, BlockType: 1, Identifier: 1, StartToken: 0, EndToken: 5, UserMarkId: 1 });
  insertRow(source, 'Note', noteDefaults({ NoteId: 1, Guid: 'idem-note', UserMarkId: 1, LocationId: 1, Title: 'Nota Z' }));

  const groups = MergeCore.listHighlightGroups(source);
  const locationIds = groups[0].locationIds;

  const first = MergeCore.mergeSelectedHighlights(target, source, locationIds);
  assert.equal(first.userMarksAdded, 1);
  assert.equal(first.notesAdded.length, 1);

  const countsAfterFirst = {
    Location: countRows(target, 'Location'),
    UserMark: countRows(target, 'UserMark'),
    BlockRange: countRows(target, 'BlockRange'),
    Note: countRows(target, 'Note')
  };

  const second = MergeCore.mergeSelectedHighlights(target, source, locationIds);
  assert.equal(second.userMarksAdded, 0);
  assert.equal(second.userMarksReused, 1);
  assert.equal(second.notesAdded.length, 0);
  assert.equal(second.notesSkipped, 1);

  assert.deepEqual(
    {
      Location: countRows(target, 'Location'),
      UserMark: countRows(target, 'UserMark'),
      BlockRange: countRows(target, 'BlockRange'),
      Note: countRows(target, 'Note')
    },
    countsAfterFirst,
    'rodar a mesma seleção de novo não deve duplicar nada'
  );

  assert.deepEqual(fkProblems(target), []);
});

test('mergeSelectedHighlights: does not touch unrelated data already in the target', async () => {
  const target = await createEmptyDb();
  const source = await createEmptyDb();

  // Dado pré-existente no destino, sem nenhuma relação com o que será importado.
  // Chave natural (KeySymbol/DocumentId) diferente da location de origem, para
  // garantir que não sejam consideradas "a mesma" location.
  insertRow(target, 'Location', locationDefaults({ LocationId: 1, Title: 'Já existia', KeySymbol: 'w', DocumentId: 1 }));
  insertRow(target, 'UserMark', userMarkDefaults({ UserMarkId: 1, LocationId: 1, UserMarkGuid: 'pre-existing-um' }));
  insertRow(target, 'Note', noteDefaults({ NoteId: 1, Guid: 'pre-existing-note', LocationId: 1, Title: 'Nota antiga', Content: 'não mexer' }));

  insertRow(source, 'Location', locationDefaults({ LocationId: 2, Title: 'Novo artigo', KeySymbol: 'g', DocumentId: 2 }));
  insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: 2, LocationId: 2, UserMarkGuid: 'new-um' }));
  insertRow(source, 'BlockRange', { BlockRangeId: 1, BlockType: 1, Identifier: 1, StartToken: 0, EndToken: 5, UserMarkId: 2 });

  const groups = MergeCore.listHighlightGroups(source);
  MergeCore.mergeSelectedHighlights(target, source, groups[0].locationIds);

  const untouchedNote = MergeCore.queryOne(target, "SELECT * FROM Note WHERE Guid='pre-existing-note'");
  assert.equal(untouchedNote.Title, 'Nota antiga');
  assert.equal(untouchedNote.Content, 'não mexer');

  const untouchedMark = MergeCore.queryOne(target, "SELECT * FROM UserMark WHERE UserMarkGuid='pre-existing-um'");
  assert.ok(untouchedMark);

  assert.equal(countRows(target, 'Location'), 2);
  assert.equal(countRows(target, 'UserMark'), 2);
  assert.deepEqual(fkProblems(target), []);
});

test('listHighlightGroups: prioritizes Title, falls back to book/chapter label for bible verses', async () => {
  const source = await createEmptyDb();

  insertRow(source, 'Location', locationDefaults({ LocationId: 1, Title: 'A Sentinela — Artigo' }));
  insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: 1, LocationId: 1, UserMarkGuid: 'g1' }));

  insertRow(source, 'Location', locationDefaults({ LocationId: 2, BookNumber: 43, ChapterNumber: 3 }));
  insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: 2, LocationId: 2, UserMarkGuid: 'g2' }));
  insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: 3, LocationId: 2, UserMarkGuid: 'g3' }));

  const groups = MergeCore.listHighlightGroups(source);
  const byLabel = Object.fromEntries(groups.map(g => [g.label, g]));

  assert.ok(byLabel['A Sentinela — Artigo']);
  assert.equal(byLabel['A Sentinela — Artigo'].count, 1);

  assert.ok(byLabel['Livro 43, capítulo 3']);
  assert.equal(byLabel['Livro 43, capítulo 3'].count, 2);
});

test('formatIssueLabel: formats "{Publicação} - {mês}/{ano}" for mwb, w and wcg', () => {
  assert.equal(MergeCore.formatIssueLabel('w', 20260700), 'A Sentinela - julho/2026');
  assert.equal(MergeCore.formatIssueLabel('mwb', 20241100), 'Apostila - novembro/2024');
  assert.equal(MergeCore.formatIssueLabel('wcg', 20250100), 'Ande Corajosamente com Deus - janeiro/2025');
});

test('listFilteredPublicationGroups: only lists mwb/w/wcg, excludes other KeySymbols', async () => {
  const source = await createEmptyDb();

  insertRow(source, 'Location', locationDefaults({ LocationId: 1, KeySymbol: 'w', IssueTagNumber: 20260700 }));
  insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: 1, LocationId: 1, UserMarkGuid: 'g1' }));

  // KeySymbol fora da lista permitida — não deve aparecer.
  insertRow(source, 'Location', locationDefaults({ LocationId: 2, KeySymbol: 'nwt', IssueTagNumber: 20260700 }));
  insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: 2, LocationId: 2, UserMarkGuid: 'g2' }));

  const groups = MergeCore.listFilteredPublicationGroups(source);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'A Sentinela - julho/2026');
  assert.equal(groups[0].count, 1);
});

test('listFilteredPublicationGroups: groups by publication, sorts by most recent, caps at 5 per publication', async () => {
  const source = await createEmptyDb();

  // 7 edições de "A Sentinela", meses diferentes de 2024/2025, mais de 5.
  const wIssues = [20240100, 20240300, 20240500, 20240700, 20240900, 20241100, 20250100];
  let locId = 1, umId = 1;
  for (const issue of wIssues) {
    insertRow(source, 'Location', locationDefaults({ LocationId: locId, KeySymbol: 'w', IssueTagNumber: issue }));
    insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: umId, LocationId: locId, UserMarkGuid: `w-${issue}` }));
    locId++; umId++;
  }

  // 2 edições de "Apostila", bem abaixo do limite.
  for (const issue of [20260100, 20260300]) {
    insertRow(source, 'Location', locationDefaults({ LocationId: locId, KeySymbol: 'mwb', IssueTagNumber: issue }));
    insertRow(source, 'UserMark', userMarkDefaults({ UserMarkId: umId, LocationId: locId, UserMarkGuid: `mwb-${issue}` }));
    locId++; umId++;
  }

  const groups = MergeCore.listFilteredPublicationGroups(source);
  const wGroups = groups.filter(g => g.label.startsWith('A Sentinela'));
  const mwbGroups = groups.filter(g => g.label.startsWith('Apostila'));

  assert.equal(wGroups.length, 5, 'no máximo 5 edições de A Sentinela, mesmo havendo 7 no arquivo');
  assert.equal(mwbGroups.length, 2);

  // As 5 mostradas devem ser as mais recentes (jan/2025 até set/2024), não as mais antigas.
  assert.deepEqual(
    wGroups.map(g => g.label),
    ['A Sentinela - janeiro/2025', 'A Sentinela - novembro/2024', 'A Sentinela - setembro/2024', 'A Sentinela - julho/2024', 'A Sentinela - maio/2024']
  );
});
