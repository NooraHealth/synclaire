export interface WatermelonLocation {
  /** Absolute directory without the `file://` scheme. */
  directory: string;
  /** File name including the `.db` extension. */
  databaseName: string;
}

export interface WatermelonLocationInput {
  platform: 'ios' | 'android';
  /** WatermelonDB `dbName` as passed to its SQLiteAdapter, e.g. `in_<userId>`. */
  dbName: string;
  /**
   * The app's document directory, e.g. expo-file-system's `Paths.document.uri`.
   * iOS: `.../Documents/`. Android: `/data/user/0/<pkg>/files/`.
   */
  documentDirectory: string;
}

function trimTrailingSlash(p: string) {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/**
 * Where WatermelonDB 0.27's native adapters keep a database file:
 * - iOS: `NSDocumentDirectory/<dbName>.db`
 * - Android: `context.getDatabasePath("<dbName>.db")` with `/databases` removed, i.e. the app's
 *   data directory root (`/data/user/0/<pkg>/<dbName>.db`), the parent of `files/`.
 */
export function watermelonDatabaseLocation(input: WatermelonLocationInput): WatermelonLocation {
  let docs = input.documentDirectory;
  if (docs.startsWith('file://')) docs = decodeURI(docs.slice('file://'.length));
  docs = trimTrailingSlash(docs);

  let directory: string;
  if (input.platform === 'ios') {
    directory = docs;
  } else {
    const idx = docs.lastIndexOf('/');
    directory = idx > 0 ? docs.slice(0, idx) : docs;
  }
  return { directory, databaseName: `${input.dbName}.db` };
}
