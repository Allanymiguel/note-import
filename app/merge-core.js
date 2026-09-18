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

  // ---------- listagem filtrada de publicações (tela "grifos de um artigo específico") ----------
  const PUBLICATION_LABELS = { w: 'A Sentinela', mwb: 'Apostila', wcg: 'Ande Corajosamente com Deus' };
  const MONTH_NAMES_PT = [
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
  ];

  // IssueTagNumber guarda ano+mês como YYYYMM00 (ex: 20260700 = julho/2026).
  function formatIssueLabel(keySymbol, issueTagNumber) {
    const friendly = PUBLICATION_LABELS[keySymbol] || keySymbol;
    const year = Math.floor(issueTagNumber / 10000);
    const month = Math.floor(issueTagNumber / 100) % 100;
    const monthName = MONTH_NAMES_PT[month - 1] || `mês ${month}`;
    if(issueTagNumber === 0) return `${friendly}`;
    return `${friendly} - ${monthName}/${year}`;
  }

  // Corta um texto em até maxLen caracteres, terminando com "..." se cortou
  // no meio — usado só como pista visual, nunca como o "título" real.
  function truncateContent(content, maxLen) {
    const trimmed = content.trim();
    if (trimmed.length <= maxLen) return trimmed;
    return trimmed.slice(0, maxLen).trimEnd() + '...';
  }

  // Primeiro Title não vazio entre as Locations de um subgrupo (mesmo
  // DocumentId), escolhido de forma determinística (menor LocationId).
  function findFirstNonEmptyTitle(source, locationIds) {
    const ids = Array.from(locationIds);
    if (!ids.length) return null;
    const placeholders = ids.map(() => '?').join(',');
    const row = queryOne(
      source,
      `SELECT Title FROM Location WHERE LocationId IN (${placeholders}) AND Title IS NOT NULL AND TRIM(Title) <> '' ORDER BY LocationId ASC LIMIT 1`,
      ids
    );
    return row ? row.Title : null;
  }

  // Primeiro Note.Content não vazio ligado a alguma Location do subgrupo.
  function findFirstNoteContent(source, locationIds) {
    const ids = Array.from(locationIds);
    if (!ids.length) return null;
    const placeholders = ids.map(() => '?').join(',');
    const row = queryOne(
      source,
      `SELECT Content FROM Note WHERE LocationId IN (${placeholders}) AND Content IS NOT NULL AND TRIM(Content) <> '' ORDER BY NoteId ASC LIMIT 1`,
      ids
    );
    return row ? row.Content : null;
  }

  // Resolve como identificar (só para exibição) o artigo de um subgrupo
  // dentro de uma edição com múltiplos DocumentId, na ordem de prioridade:
  // Title real > trecho de uma Note > rótulo genérico honesto. NUNCA usa o
  // DocumentId cru, que é só um id interno sem relação com a numeração
  // impressa do artigo.
  function resolveArticleSuffix(source, subgroup) {
    const title = findFirstNonEmptyTitle(source, subgroup.locationIds);
    if (title) return { kind: 'title', text: title };
    const noteContent = findFirstNoteContent(source, subgroup.locationIds);
    if (noteContent) return { kind: 'note', text: truncateContent(noteContent, 50) };
    return { kind: 'generic' };
  }

  // Lista, para a tela de escolha de artigo específico, apenas grifos de
  // publicações periódicas conhecidas (Sentinela/Apostila/Ande Corajosamente
  // com Deus), agrupados por edição (KeySymbol + IssueTagNumber) e, dentro
  // de cada edição, por artigo (DocumentId) quando houver mais de um. Isso é
  // só um filtro/rótulo de EXIBIÇÃO: não descarta nem altera nenhum dado do
  // arquivo de origem, só o que aparece pré-selecionável nessa tela. O
  // limite de `maxPerPublication` é aplicado à lista já expandida por
  // artigo, então uma edição com vários artigos pode sozinha consumir a
  // cota de itens mais recentes daquela publicação.
  function listFilteredPublicationGroups(source, maxPerPublication = 5) {
    const allowedKeys = Object.keys(PUBLICATION_LABELS);

    const marks = queryAll(source, 'SELECT UserMarkId, LocationId FROM UserMark');
    const countByLocation = new Map();
    for (const m of marks) {
      if (m.LocationId === null || m.LocationId === undefined) continue;
      countByLocation.set(m.LocationId, (countByLocation.get(m.LocationId) || 0) + 1);
    }

    // issueKey (`${KeySymbol}:${IssueTagNumber}`) -> { keySymbol, issueTagNumber, subgroups: Map(docKey -> {...}) }
    const issueGroups = new Map();
    for (const locId of countByLocation.keys()) {
      const loc = queryOne(source, 'SELECT * FROM Location WHERE LocationId=?', [locId]);
      if (!loc) continue;
      if (!allowedKeys.includes(loc.KeySymbol)) continue;
      if (loc.IssueTagNumber === null || loc.IssueTagNumber === undefined) continue;

      const issueKey = `${loc.KeySymbol}:${loc.IssueTagNumber}`;
      if (!issueGroups.has(issueKey)) {
        issueGroups.set(issueKey, { keySymbol: loc.KeySymbol, issueTagNumber: loc.IssueTagNumber, subgroups: new Map() });
      }
      const issue = issueGroups.get(issueKey);

      const docKey = loc.DocumentId === null || loc.DocumentId === undefined ? '\u0000' : String(loc.DocumentId);
      if (!issue.subgroups.has(docKey)) {
        issue.subgroups.set(docKey, { locationIds: new Set(), count: 0, firstLocationId: locId, documentId: loc.DocumentId });
      }
      const sub = issue.subgroups.get(docKey);
      sub.locationIds.add(locId);
      sub.count += countByLocation.get(locId);
      if (locId < sub.firstLocationId) sub.firstLocationId = locId;
    }

    const byKeySymbol = new Map();
    for (const issue of issueGroups.values()) {
      if (!byKeySymbol.has(issue.keySymbol)) byKeySymbol.set(issue.keySymbol, []);
      byKeySymbol.get(issue.keySymbol).push(issue);
    }

    const result = [];
    for (const keySymbol of allowedKeys) {
      const issuesMostRecentFirst = (byKeySymbol.get(keySymbol) || [])
        .sort((a, b) => b.issueTagNumber - a.issueTagNumber);

      const items = [];
      for (const issue of issuesMostRecentFirst) {
        if (items.length >= maxPerPublication) break;

        const issueLabel = formatIssueLabel(issue.keySymbol, issue.issueTagNumber);
        const subgroups = Array.from(issue.subgroups.values())
          .sort((a, b) => a.firstLocationId - b.firstLocationId);

        if (subgroups.length === 1) {
          const sub = subgroups[0];
          items.push({
            key: `${issue.keySymbol}:${issue.issueTagNumber}:${sub.firstLocationId}`,
            label: issueLabel,
            count: sub.count,
            locationIds: Array.from(sub.locationIds),
            keySymbol: issue.keySymbol,
            issueTagNumber: issue.issueTagNumber,
            documentIds: [sub.documentId]
          });
          continue;
        }

        // Mais de um artigo na mesma edição: só vale a pena desdobrar em
        // itens separados quando existir alguma pista real (Title ou Note)
        // para diferenciá-los — um rótulo genérico por DocumentId não ajuda
        // em nada e só polui a lista.
        const resolved = subgroups.map(sub => resolveArticleSuffix(source, sub));
        const identifiableIndexes = resolved
          .map((r, i) => (r.kind !== 'generic' ? i : -1))
          .filter(i => i !== -1);

        if (identifiableIndexes.length === 0) {
          // Nenhum artigo identificável: mostra a edição inteira como um item só.
          const locationIds = [];
          const documentIds = [];
          let totalCount = 0;
          for (const sub of subgroups) {
            locationIds.push(...sub.locationIds);
            documentIds.push(sub.documentId);
            totalCount += sub.count;
          }
          items.push({
            key: `${issue.keySymbol}:${issue.issueTagNumber}`,
            label: issueLabel,
            count: totalCount,
            locationIds,
            keySymbol: issue.keySymbol,
            issueTagNumber: issue.issueTagNumber,
            documentIds
          });
          continue;
        }

        for (const i of identifiableIndexes) {
          if (items.length >= maxPerPublication) break;
          const sub = subgroups[i];
          const r = resolved[i];
          const suffix = r.kind === 'title' ? r.text : `Nota: "${r.text}"`;

          items.push({
            key: `${issue.keySymbol}:${issue.issueTagNumber}:${sub.firstLocationId}`,
            label: `${issueLabel} | ${suffix}`,
            count: sub.count,
            locationIds: Array.from(sub.locationIds),
            keySymbol: issue.keySymbol,
            issueTagNumber: issue.issueTagNumber,
            documentIds: [sub.documentId]
          });
        }

        const nonIdentifiable = subgroups.filter((_, i) => resolved[i].kind === 'generic');
        if (nonIdentifiable.length > 0 && items.length < maxPerPublication) {
          const locationIds = [];
          const documentIds = [];
          let totalCount = 0;
          for (const sub of nonIdentifiable) {
            locationIds.push(...sub.locationIds);
            documentIds.push(sub.documentId);
            totalCount += sub.count;
          }
          items.push({
            key: `${issue.keySymbol}:${issue.issueTagNumber}:others`,
            label: `${issueLabel} | Outros grifos dessa edição`,
            count: totalCount,
            locationIds,
            keySymbol: issue.keySymbol,
            issueTagNumber: issue.issueTagNumber,
            documentIds
          });
        }
      }

      result.push(...items.slice(0, maxPerPublication));
    }
    return result;
  }

  // ---------- aviso de confirmação quando já existem grifos na mesma publicação ----------
  // Para cada grupo selecionado (identificado por KeySymbol + IssueTagNumber +
  // DocumentId), verifica se o destino já tem QUALQUER UserMark numa Location
  // com essa mesma combinação — não compara trechos (StartToken/EndToken) nem
  // faz nenhuma checagem de "grifo parecido", só presença. Somente leitura:
  // nenhuma linha é escrita no banco de destino.
  function countPublicationsWithExistingHighlights(target, groups) {
    let count = 0;
    const matchedKeys = [];
    for (const g of groups) {
      const documentIds = g.documentIds && g.documentIds.length ? g.documentIds : [g.documentId];
      const hasExisting = documentIds.some(documentId => queryOne(
        target,
        `SELECT UserMark.UserMarkId
         FROM UserMark
         JOIN Location ON Location.LocationId = UserMark.LocationId
         WHERE Location.KeySymbol IS ? AND Location.IssueTagNumber IS ? AND Location.DocumentId IS ?
         LIMIT 1`,
        [g.keySymbol, g.issueTagNumber, documentId]
      ));
      if (hasExisting) {
        count++;
        matchedKeys.push(g.key);
      }
    }
    return { count, matchedKeys };
  }

  // Mensagem de confirmação exibida antes do merge, quando count > 0.
  function formatOverlapWarning(count) {
    const plural = count === 1 ? '1 dessas publicações' : `${count} dessas publicações`;
    return `Você já tem grifos em ${plural}. Isso não vai apagar nada — os grifos novos serão adicionados ao lado dos que você já tem. Deseja continuar?`;
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
    formatIssueLabel,
    listFilteredPublicationGroups,
    countPublicationsWithExistingHighlights,
    formatOverlapWarning,
    mergeSelectedHighlights,
    loadDbFromZip
  };
});
