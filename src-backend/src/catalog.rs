//! Culling catalog: star ratings and pick/reject flags, kept between sessions
//! in an SQLite file in the app data folder, one row per photo path.
//! Photos with no rating and no flag have no row, so the table only grows
//! with photos that were actually culled.

use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use tauri::{AppHandle, Manager, State};

use crate::blocking;

const DB_FILE: &str = "catalog.sqlite3";

/// Opened on first use.
#[derive(Default)]
pub struct Catalog(Mutex<Option<Connection>>);

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct Entry {
    pub path: String,
    pub rating: u8,
    /// "pick", "reject", or null.
    pub flag: Option<String>,
}

fn open(path: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    init(&conn)?;
    Ok(conn)
}

fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS photos (
           path TEXT PRIMARY KEY,
           rating INTEGER NOT NULL DEFAULT 0,
           flag TEXT,
           updated_at INTEGER NOT NULL
         ) WITHOUT ROWID;",
    )
    .map_err(|e| e.to_string())
}

/// Entries for the given paths that have a rating or flag, in one transaction.
fn get(conn: &mut Connection, paths: &[String]) -> Result<Vec<Entry>, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    {
        let mut stmt = tx
            .prepare_cached("SELECT rating, flag FROM photos WHERE path = ?1")
            .map_err(|e| e.to_string())?;
        for path in paths {
            let row = stmt
                .query_row(params![path], |r| Ok((r.get::<_, u8>(0)?, r.get::<_, Option<String>>(1)?)))
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some((rating, flag)) = row {
                out.push(Entry { path: path.clone(), rating, flag });
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
}

/// Upsert entries; an entry back at the defaults deletes its row.
fn set(conn: &mut Connection, entries: &[Entry]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    write(&tx, entries)?;
    tx.commit().map_err(|e| e.to_string())
}

fn write(tx: &rusqlite::Transaction<'_>, entries: &[Entry]) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut upsert = tx
        .prepare_cached(
            "INSERT INTO photos (path, rating, flag, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET rating = ?2, flag = ?3, updated_at = ?4",
        )
        .map_err(|e| e.to_string())?;
    let mut delete = tx
        .prepare_cached("DELETE FROM photos WHERE path = ?1")
        .map_err(|e| e.to_string())?;
    for e in entries {
        let flag = e.flag.as_deref().filter(|f| *f == "pick" || *f == "reject");
        if e.rating == 0 && flag.is_none() {
            delete.execute(params![e.path]).map_err(|e| e.to_string())?;
        } else {
            upsert
                .execute(params![e.path, e.rating.min(5), flag, now])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Every row, for backups.
fn all(conn: &mut Connection) -> Result<Vec<Entry>, String> {
    let mut stmt = conn.prepare("SELECT path, rating, flag FROM photos ORDER BY path").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(Entry { path: r.get(0)?, rating: r.get(1)?, flag: r.get(2)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Replace the whole catalog with `entries` (restoring a backup) in one
/// transaction: a failed restore leaves the old catalog untouched.
fn replace_all(conn: &mut Connection, entries: &[Entry]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM photos", []).map_err(|e| e.to_string())?;
    write(&tx, entries)?;
    tx.commit().map_err(|e| e.to_string())
}

/// Run `f` on the connection, opening the database on first use.
async fn with_conn<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    blocking(move || {
        let state = app.state::<Catalog>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            *guard = Some(open(&dir.join(DB_FILE))?);
        }
        f(guard.as_mut().expect("opened above"))
    })
    .await
}

#[tauri::command]
pub async fn catalog_get(
    app: AppHandle,
    _catalog: State<'_, Catalog>,
    paths: Vec<String>,
) -> Result<Vec<Entry>, String> {
    with_conn(app, move |c| get(c, &paths)).await
}

#[tauri::command]
pub async fn catalog_set(
    app: AppHandle,
    _catalog: State<'_, Catalog>,
    entries: Vec<Entry>,
) -> Result<(), String> {
    with_conn(app, move |c| set(c, &entries)).await
}

/// Every rating and flag, for a backup.
#[tauri::command]
pub async fn catalog_export(app: AppHandle, _catalog: State<'_, Catalog>) -> Result<Vec<Entry>, String> {
    with_conn(app, all).await
}

/// Replace the catalog with a backup's entries.
#[tauri::command]
pub async fn catalog_import(
    app: AppHandle,
    _catalog: State<'_, Catalog>,
    entries: Vec<Entry>,
) -> Result<(), String> {
    with_conn(app, move |c| replace_all(c, &entries)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, rating: u8, flag: Option<&str>) -> Entry {
        Entry { path: path.into(), rating, flag: flag.map(Into::into) }
    }

    #[test]
    fn set_get_update_and_clear() {
        let mut c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        set(&mut c, &[entry("/a.jpg", 3, None), entry("/b.jpg", 0, Some("pick"))]).unwrap();
        let paths = vec!["/a.jpg".into(), "/b.jpg".into(), "/missing.jpg".into()];
        assert_eq!(get(&mut c, &paths).unwrap(), vec![entry("/a.jpg", 3, None), entry("/b.jpg", 0, Some("pick"))]);

        set(&mut c, &[entry("/a.jpg", 5, Some("reject")), entry("/b.jpg", 0, None)]).unwrap();
        assert_eq!(get(&mut c, &paths).unwrap(), vec![entry("/a.jpg", 5, Some("reject"))]);
        let rows: i64 = c.query_row("SELECT COUNT(*) FROM photos", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "a cleared entry deletes its row");
    }

    #[test]
    fn export_and_replace() {
        let mut c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        set(&mut c, &[entry("/a.jpg", 3, None), entry("/b.jpg", 1, Some("reject"))]).unwrap();
        let backup = all(&mut c).unwrap();
        set(&mut c, &[entry("/c.jpg", 5, Some("pick"))]).unwrap();
        replace_all(&mut c, &backup).unwrap();
        assert_eq!(all(&mut c).unwrap(), backup, "restore replaces, not merges");
    }

    /// The "is it fast with many photos" question, measured: 100k culled
    /// photos in the table, then a 2,000-photo import looked up in one call.
    #[test]
    fn large_catalog_stays_fast() {
        let dir = std::env::temp_dir().join(format!("sabattier-catalog-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut c = open(&dir.join(DB_FILE)).unwrap();
        let all: Vec<Entry> = (0..100_000).map(|i| entry(&format!("/photos/{i:06}.jpg"), (i % 6) as u8, None)).collect();
        let t = std::time::Instant::now();
        set(&mut c, &all).unwrap();
        let write = t.elapsed();

        let import: Vec<String> = (0..2_000).map(|i| format!("/photos/{:06}.jpg", i * 37)).collect();
        let t = std::time::Instant::now();
        let found = get(&mut c, &import).unwrap();
        let read = t.elapsed();
        let t = std::time::Instant::now();
        set(&mut c, &[entry("/photos/000001.jpg", 4, Some("pick"))]).unwrap();
        let one = t.elapsed();
        eprintln!("100k rows written in {write:?}; 2,000 lookups in {read:?}; one rating saved in {one:?}");
        assert!(!found.is_empty());
        assert!(read.as_millis() < 500, "2,000 lookups took {read:?}");
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
