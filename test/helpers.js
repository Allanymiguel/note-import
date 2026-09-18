const initSqlJs = require('sql.js');

// Esquema mínimo do userData.db do JW Library, só com as colunas usadas
// pela lógica de merge (app/merge-core.js), com as mesmas foreign keys
// reais para que PRAGMA foreign_key_check seja um teste significativo.
const SCHEMA = `
CREATE TABLE Location (
  LocationId INTEGER PRIMARY KEY,
  BookNumber INTEGER,
  ChapterNumber INTEGER,
  DocumentId INTEGER,
  Track INTEGER,
  IssueTagNumber INTEGER,
  KeySymbol TEXT,
  MepsLanguage INTEGER,
  Type INTEGER,
  Title TEXT,
  Specialty INTEGER,
  Edition TEXT
);
CREATE TABLE UserMark (
  UserMarkId INTEGER PRIMARY KEY,
  ColorIndex INTEGER,
  LocationId INTEGER REFERENCES Location(LocationId),
  StyleIndex INTEGER,
  UserMarkGuid TEXT UNIQUE NOT NULL,
  Version INTEGER
);
CREATE TABLE BlockRange (
  BlockRangeId INTEGER PRIMARY KEY,
  BlockType INTEGER,
  Identifier INTEGER,
  StartToken INTEGER,
  EndToken INTEGER,
  UserMarkId INTEGER REFERENCES UserMark(UserMarkId)
);
CREATE TABLE Tag (
  TagId INTEGER PRIMARY KEY,
  Type INTEGER,
  Name TEXT
);
CREATE TABLE Note (
  NoteId INTEGER PRIMARY KEY,
  Guid TEXT UNIQUE NOT NULL,
  UserMarkId INTEGER REFERENCES UserMark(UserMarkId),
  LocationId INTEGER REFERENCES Location(LocationId),
  Title TEXT,
  Content TEXT,
  LastModified TEXT,
  Created TEXT,
  BlockType INTEGER,
  BlockIdentifier INTEGER
);
CREATE TABLE TagMap (
  TagMapId INTEGER PRIMARY KEY,
  PlaylistItemId INTEGER,
  LocationId INTEGER,
  NoteId INTEGER REFERENCES Note(NoteId),
  TagId INTEGER REFERENCES Tag(TagId),
  Position INTEGER
);
`;

let sqlPromise = null;
function getSQL() {
  if (!sqlPromise) sqlPromise = initSqlJs();
  return sqlPromise;
}

async function createEmptyDb() {
  const SQL = await getSQL();
  const db = new SQL.Database();
  db.run(SCHEMA);
  return db;
}

function insertRow(db, table, row) {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(',');
  db.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`, cols.map(c => row[c]));
}

function countRows(db, table) {
  const res = db.exec(`SELECT COUNT(*) FROM ${table}`);
  return res[0].values[0][0];
}

function locationDefaults(overrides) {
  return Object.assign({
    LocationId: null,
    BookNumber: null,
    ChapterNumber: null,
    DocumentId: null,
    Track: null,
    IssueTagNumber: null,
    KeySymbol: null,
    MepsLanguage: null,
    Type: null,
    Title: null,
    Specialty: null,
    Edition: null
  }, overrides);
}

function userMarkDefaults(overrides) {
  return Object.assign({
    UserMarkId: null,
    ColorIndex: 1,
    LocationId: null,
    StyleIndex: 0,
    UserMarkGuid: null,
    Version: 1
  }, overrides);
}

function noteDefaults(overrides) {
  return Object.assign({
    NoteId: null,
    Guid: null,
    UserMarkId: null,
    LocationId: null,
    Title: '',
    Content: '',
    LastModified: '2024-01-01T00:00:00Z',
    Created: '2024-01-01T00:00:00Z',
    BlockType: 0,
    BlockIdentifier: null
  }, overrides);
}

module.exports = {
  getSQL,
  createEmptyDb,
  insertRow,
  countRows,
  locationDefaults,
  userMarkDefaults,
  noteDefaults
};
