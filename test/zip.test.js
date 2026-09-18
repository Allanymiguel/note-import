const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const MergeCore = require('../app/merge-core.js');
const { getSQL, createEmptyDb, insertRow, locationDefaults, userMarkDefaults } = require('./helpers.js');

test('loadDbFromZip: reads userData.db from a valid .jwlibrary zip', async () => {
  const SQL = await getSQL();
  const db = await createEmptyDb();
  insertRow(db, 'Location', locationDefaults({ LocationId: 1, Title: 'Artigo' }));
  insertRow(db, 'UserMark', userMarkDefaults({ UserMarkId: 1, LocationId: 1, UserMarkGuid: 'g1' }));

  const zip = new JSZip();
  zip.file('userData.db', db.export());
  const bytes = await zip.generateAsync({ type: 'uint8array' });

  const result = await MergeCore.loadDbFromZip(JSZip, SQL, bytes);
  assert.equal(result.ok, true);
  const groups = MergeCore.listHighlightGroups(result.db);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'Artigo');
});

test('loadDbFromZip: reports "no-db" when userData.db is missing', async () => {
  const SQL = await getSQL();
  const zip = new JSZip();
  zip.file('readme.txt', 'not a real backup');
  const bytes = await zip.generateAsync({ type: 'uint8array' });

  const result = await MergeCore.loadDbFromZip(JSZip, SQL, bytes);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-db');
});

test('loadDbFromZip: reports "bad-schema" when userData.db has no Note table', async () => {
  const SQL = await getSQL();
  const bogusDb = new SQL.Database();
  bogusDb.run('CREATE TABLE SomethingElse (Id INTEGER PRIMARY KEY)');

  const zip = new JSZip();
  zip.file('userData.db', bogusDb.export());
  const bytes = await zip.generateAsync({ type: 'uint8array' });

  const result = await MergeCore.loadDbFromZip(JSZip, SQL, bytes);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-schema');
});

test('loadDbFromZip: reports "unzip" when the file is not a zip at all', async () => {
  const SQL = await getSQL();
  const bytes = new TextEncoder().encode('esto no es un zip');

  const result = await MergeCore.loadDbFromZip(JSZip, SQL, bytes);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unzip');
});

test('end-to-end: merge selected highlights across two real .jwlibrary zips and re-export', async () => {
  const SQL = await getSQL();

  const targetDb = await createEmptyDb();
  const sourceDb = await createEmptyDb();

  insertRow(sourceDb, 'Location', locationDefaults({ LocationId: 1, Title: 'Discurso especial' }));
  insertRow(sourceDb, 'UserMark', userMarkDefaults({ UserMarkId: 1, LocationId: 1, UserMarkGuid: 'e2e-um' }));
  insertRow(sourceDb, 'BlockRange', { BlockRangeId: 1, BlockType: 1, Identifier: 1, StartToken: 0, EndToken: 5, UserMarkId: 1 });

  const targetZip = new JSZip();
  targetZip.file('userData.db', targetDb.export());
  const targetBytes = await targetZip.generateAsync({ type: 'uint8array' });

  const sourceZip = new JSZip();
  sourceZip.file('userData.db', sourceDb.export());
  const sourceBytes = await sourceZip.generateAsync({ type: 'uint8array' });

  const loadedTarget = await MergeCore.loadDbFromZip(JSZip, SQL, targetBytes);
  const loadedSource = await MergeCore.loadDbFromZip(JSZip, SQL, sourceBytes);
  assert.equal(loadedTarget.ok, true);
  assert.equal(loadedSource.ok, true);

  const groups = MergeCore.listHighlightGroups(loadedSource.db);
  const report = MergeCore.mergeSelectedHighlights(loadedTarget.db, loadedSource.db, groups[0].locationIds);
  assert.equal(report.userMarksAdded, 1);

  const problems = MergeCore.queryAll(loadedTarget.db, 'PRAGMA foreign_key_check');
  assert.deepEqual(problems, []);

  // Reempacota, exatamente como faz a UI, e confirma que o resultado final
  // continua sendo um .jwlibrary (zip com userData.db) válido e legível.
  const newDbBytes = loadedTarget.db.export();
  loadedTarget.zip.file('userData.db', newDbBytes);
  const outBytes = await loadedTarget.zip.generateAsync({ type: 'uint8array', mimeType: 'application/octet-stream' });

  const reloaded = await MergeCore.loadDbFromZip(JSZip, SQL, outBytes);
  assert.equal(reloaded.ok, true);
  const finalGroups = MergeCore.listHighlightGroups(reloaded.db);
  assert.equal(finalGroups.length, 1);
  assert.equal(finalGroups[0].label, 'Discurso especial');

  // O arquivo de origem original não foi alterado (merge só escreveu na cópia em memória do destino).
  const stillOneMarkInSource = MergeCore.queryAll(loadedSource.db, 'SELECT * FROM UserMark');
  assert.equal(stillOneMarkInSource.length, 1);
});
