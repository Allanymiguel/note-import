/**
 * Core merge logic for JW Library .jwlibrary backups.
 * Shared between the browser (mesclar_notas.html, loaded via <script>) and
 * the Node test suite (required directly). No DOM/browser APIs are used
 * here so it works unmodified in both environments.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.MergeCore = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // ---------- helpers de SQL sobre sql.js ----------
  function queryAll(db, sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
  function queryOne(db, sql, params = []) {
    const rows = queryAll(db, sql, params);
    return rows.length ? rows[0] : null;
  }
  function run(db, sql, params = []) {
    db.run(sql, params);
  }
  function lastId(db) {
    return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  }

  // ---------- resolução de entidades (nunca reaproveita IDs numéricos da origem) ----------
  function findOrCreateLocation(target, source, sourceLocationId, cache) {
    if (sourceLocationId === null || sourceLocationId === undefined) return null;
    if (cache.has(sourceLocationId)) return cache.get(sourceLocationId);

    const loc = queryOne(source, 'SELECT * FROM Location WHERE LocationId=?', [sourceLocationId]);
    const existing = queryOne(target,
      `SELECT LocationId FROM Location
       WHERE BookNumber IS ? AND ChapterNumber IS ? AND KeySymbol IS ?
         AND MepsLanguage IS ? AND Type IS ? AND DocumentId IS ? AND Track IS ?`,
      [loc.BookNumber, loc.ChapterNumber, loc.KeySymbol, loc.MepsLanguage, loc.Type, loc.DocumentId, loc.Track]
    );
    if (existing) { cache.set(sourceLocationId, existing.LocationId); return existing.LocationId; }

    run(target,
      `INSERT INTO Location (BookNumber, ChapterNumber, DocumentId, Track, IssueTagNumber, KeySymbol, MepsLanguage, Type, Title, Specialty, Edition)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [loc.BookNumber, loc.ChapterNumber, loc.DocumentId, loc.Track, loc.IssueTagNumber, loc.KeySymbol, loc.MepsLanguage, loc.Type, loc.Title, loc.Specialty, loc.Edition]
    );
    const newId = lastId(target);
    cache.set(sourceLocationId, newId);
    return newId;
  }

  function findOrCreateUserMark(target, source, sourceUserMarkId, newLocationId, cache) {
    if (sourceUserMarkId === null || sourceUserMarkId === undefined) return null;
    if (cache.has(sourceUserMarkId)) return cache.get(sourceUserMarkId);

    const um = queryOne(source, 'SELECT * FROM UserMark WHERE UserMarkId=?', [sourceUserMarkId]);
    const existing = queryOne(target, 'SELECT UserMarkId FROM UserMark WHERE UserMarkGuid=?', [um.UserMarkGuid]);
    if (existing) { cache.set(sourceUserMarkId, existing.UserMarkId); return existing.UserMarkId; }

    run(target,
      'INSERT INTO UserMark (ColorIndex, LocationId, StyleIndex, UserMarkGuid, Version) VALUES (?,?,?,?,?)',
      [um.ColorIndex, newLocationId, um.StyleIndex, um.UserMarkGuid, um.Version]
    );
    const newId = lastId(target);
    cache.set(sourceUserMarkId, newId);

    const ranges = queryAll(source, 'SELECT * FROM BlockRange WHERE UserMarkId=?', [sourceUserMarkId]);
    for (const br of ranges) {
      run(target,
        'INSERT INTO BlockRange (BlockType, Identifier, StartToken, EndToken, UserMarkId) VALUES (?,?,?,?,?)',
        [br.BlockType, br.Identifier, br.StartToken, br.EndToken, newId]
      );
    }
    return newId;
  }

  function findOrCreateTag(target, source, sourceTagId, cache) {
    if (cache.has(sourceTagId)) return cache.get(sourceTagId);
    const tag = queryOne(source, 'SELECT Type, Name FROM Tag WHERE TagId=?', [sourceTagId]);
    const existing = queryOne(target, 'SELECT TagId FROM Tag WHERE Type=? AND Name=?', [tag.Type, tag.Name]);
    if (existing) { cache.set(sourceTagId, existing.TagId); return existing.TagId; }
    run(target, 'INSERT INTO Tag (Type, Name) VALUES (?,?)', [tag.Type, tag.Name]);
    const newId = lastId(target);
    cache.set(sourceTagId, newId);
    return newId;
  }

  // Insere no destino a lista de notas informada (já filtrada por quem chamou),
  // pulando qualquer nota cujo Guid já exista no destino. Recebe caches
  // compartilhados para que Location/UserMark/Tag já resolvidos não sejam
  // reprocessados nem duplicados.
  function mergeNoteList(target, source, notes, caches) {
    const existingGuids = new Set(queryAll(target, 'SELECT Guid FROM Note').map(r => r.Guid));
    const added = [], skipped = [];

    for (const note of notes) {
      if (existingGuids.has(note.Guid)) { skipped.push(note.Guid); continue; }

      const newLocationId = findOrCreateLocation(target, source, note.LocationId, caches.locationCache);
      const newUserMarkId = findOrCreateUserMark(target, source, note.UserMarkId, newLocationId, caches.userMarkCache);

      run(target,
        `INSERT INTO Note (Guid, UserMarkId, LocationId, Title, Content, LastModified, Created, BlockType, BlockIdentifier)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [note.Guid, newUserMarkId, newLocationId, note.Title, note.Content, note.LastModified, note.Created, note.BlockType, note.BlockIdentifier]
      );
      const newNoteId = lastId(target);

      const tagMaps = queryAll(source, 'SELECT TagId FROM TagMap WHERE NoteId=?', [note.NoteId]);
      for (const tm of tagMaps) {
        const newTagId = findOrCreateTag(target, source, tm.TagId, caches.tagCache);
        const posRow = queryOne(target, 'SELECT COALESCE(MAX(Position), -1) + 1 AS p FROM TagMap WHERE TagId=?', [newTagId]);
        run(target, 'INSERT INTO TagMap (PlaylistItemId, LocationId, NoteId, TagId, Position) VALUES (NULL, NULL, ?, ?, ?)', [newNoteId, newTagId, posRow.p]);
      }

      added.push({ guid: note.Guid, title: note.Title, content: note.Content });
    }

    return { added, skipped };
  }

  // Mescla TODAS as notas da origem para o destino (comportamento original).
  function mergeNotes(target, source) {
    const beforeCount = queryOne(target, 'SELECT COUNT(*) AS c FROM Note').c;
    const sourceNotes = queryAll(source, 'SELECT * FROM Note');
    const caches = { locationCache: new Map(), userMarkCache: new Map(), tagCache: new Map() };
    const result = mergeNoteList(target, source, sourceNotes, caches);
    return { added: result.added, skipped: result.skipped, beforeCount };
  }

  // ---------- agrupamento de grifos por artigo/publicação/capítulo ----------
  function buildLocationLabel(loc) {
    if (loc.Title) return loc.Title;
    if (loc.BookNumber !== null && loc.BookNumber !== undefined) {
      return loc.ChapterNumber !== null && loc.ChapterNumber !== undefined
        ? `Livro ${loc.BookNumber}, capítulo ${loc.ChapterNumber}`
        : `Livro ${loc.BookNumber}`;
    }
    if (loc.KeySymbol) return loc.KeySymbol;
    return `Publicação sem título (local ${loc.LocationId})`;
  }

  function groupKeyForLocation(loc) {
    if (loc.BookNumber !== null && loc.BookNumber !== undefined) {
      return `bible:${loc.BookNumber}:${loc.ChapterNumber}`;
    }
    return `pub:${loc.KeySymbol || ''}:${loc.DocumentId ?? ''}:${loc.MepsLanguage ?? ''}:${loc.Track ?? ''}`;
  }

  // Lê todos os grifos (UserMark) da origem e agrupa por artigo/publicação/
  // capítulo, para exibir como opções de seleção ao usuário.
  function listHighlightGroups(source) {
    const marks = queryAll(source, 'SELECT UserMarkId, LocationId FROM UserMark');
    const countByLocation = new Map();
    for (const m of marks) {
      if (m.LocationId === null || m.LocationId === undefined) continue;
      countByLocation.set(m.LocationId, (countByLocation.get(m.LocationId) || 0) + 1);
    }

    const groups = new Map();
    for (const locId of countByLocation.keys()) {
      const loc = queryOne(source, 'SELECT * FROM Location WHERE LocationId=?', [locId]);
      if (!loc) continue;
      const key = groupKeyForLocation(loc);
      if (!groups.has(key)) {
        groups.set(key, { key, label: buildLocationLabel(loc), locationIds: new Set(), count: 0 });
      }
      const g = groups.get(key);
      g.locationIds.add(locId);
      g.count += countByLocation.get(locId);
    }

    return Array.from(groups.values())
      .map(g => ({ key: g.key, label: g.label, count: g.count, locationIds: Array.from(g.locationIds) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  }

  // Mescla para o destino APENAS os grifos (UserMark) cujo LocationId esteja
  // em selectedLocationIds, seus BlockRange, a Location correspondente, e
  // qualquer Note ligada a esses grifos (com seus Tag/TagMap), reaproveitando
  // a mesma lógica de dedup usada no merge completo.
  function mergeSelectedHighlights(target, source, selectedLocationIds) {
    const locSet = new Set(selectedLocationIds);
    const sourceUserMarks = queryAll(source, 'SELECT * FROM UserMark')
      .filter(um => um.LocationId !== null && um.LocationId !== undefined && locSet.has(um.LocationId));

    const caches = { locationCache: new Map(), userMarkCache: new Map(), tagCache: new Map() };

    let userMarksAdded = 0, userMarksReused = 0;
    for (const um of sourceUserMarks) {
      const alreadyInTarget = queryOne(target, 'SELECT UserMarkId FROM UserMark WHERE UserMarkGuid=?', [um.UserMarkGuid]);
      const newLocationId = findOrCreateLocation(target, source, um.LocationId, caches.locationCache);
      findOrCreateUserMark(target, source, um.UserMarkId, newLocationId, caches.userMarkCache);
      if (alreadyInTarget) userMarksReused++; else userMarksAdded++;
    }

    const relevantUserMarkIds = new Set(sourceUserMarks.map(u => u.UserMarkId));
    const sourceNotes = queryAll(source, 'SELECT * FROM Note')
      .filter(n => n.UserMarkId !== null && n.UserMarkId !== undefined && relevantUserMarkIds.has(n.UserMarkId));
    const noteResult = mergeNoteList(target, source, sourceNotes, caches);

    return {
      userMarksAdded,
      userMarksReused,
      totalSelectedUserMarks: sourceUserMarks.length,
      notesAdded: noteResult.added,
      notesSkipped: noteResult.skipped.length
    };
  }

  // ---------- leitura de um backup .jwlibrary (zip contendo userData.db) ----------
  // JSZipLib e SQLLib são recebidos por parâmetro para funcionar tanto no
  // navegador (globais JSZip/SQL) quanto no Node (require('jszip')/require('sql.js')).
  async function loadDbFromZip(JSZipLib, SQLLib, bytes) {
    let zip;
    try {
      zip = await JSZipLib.loadAsync(bytes);
    } catch (err) {
      return { ok: false, reason: 'unzip', error: err };
    }
    const dbEntry = zip.file('userData.db');
    if (!dbEntry) {
      return { ok: false, reason: 'no-db', error: new Error('userData.db not found in archive') };
    }
    const dbBytes = await dbEntry.async('uint8array');
    const db = new SQLLib.Database(dbBytes);
    const hasNoteTable = queryOne(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='Note'");
    if (!hasNoteTable) {
      return { ok: false, reason: 'bad-schema', error: new Error('Note table not found') };
    }
    return { ok: true, db, zip };
  }

  return {
    queryAll,
    queryOne,
    run,
    lastId,
    findOrCreateLocation,
    findOrCreateUserMark,
    findOrCreateTag,
    mergeNoteList,
    mergeNotes,
    buildLocationLabel,
    groupKeyForLocation,
    listHighlightGroups,
    mergeSelectedHighlights,
    loadDbFromZip
  };
});
