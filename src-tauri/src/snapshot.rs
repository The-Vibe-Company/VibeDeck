use crate::{
    error::ApiError,
    model::{BootstrapResponse, FIRST_PAGE_SIZE},
};
use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::PathBuf};

const SNAPSHOT_VERSION: u8 = 1;
const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEnvelope {
    version: u8,
    checksum: String,
    payload: BootstrapResponse,
}

#[derive(Clone, Debug)]
pub struct StartupSnapshotStore {
    path: PathBuf,
}

impl StartupSnapshotStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn load(&self) -> Result<Option<BootstrapResponse>, ApiError> {
        let metadata = match fs::metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(snapshot_io_error(error)),
        };
        if metadata.len() > MAX_SNAPSHOT_BYTES as u64 {
            return Ok(None);
        }

        let bytes = fs::read(&self.path).map_err(snapshot_io_error)?;
        let envelope: SnapshotEnvelope = match serde_json::from_slice(&bytes) {
            Ok(envelope) => envelope,
            Err(_) => return Ok(None),
        };
        if envelope.version != SNAPSHOT_VERSION || !is_valid_payload(&envelope.payload) {
            return Ok(None);
        }
        let payload = serde_json::to_vec(&envelope.payload)?;
        if checksum(&payload) != envelope.checksum {
            return Ok(None);
        }
        Ok(Some(envelope.payload))
    }

    pub fn save(&self, payload: &BootstrapResponse) -> Result<(), ApiError> {
        if !is_valid_payload(payload) {
            return Err(ApiError::invalid("Snapshot de démarrage invalide."));
        }
        let payload_bytes = serde_json::to_vec(payload)?;
        let envelope = SnapshotEnvelope {
            version: SNAPSHOT_VERSION,
            checksum: checksum(&payload_bytes),
            payload: payload.clone(),
        };
        let bytes = serde_json::to_vec(&envelope)?;
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err(ApiError::invalid("Le snapshot de démarrage dépasse 1 Mio."));
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(snapshot_io_error)?;
        }

        let mut file = AtomicWriteFile::open(&self.path).map_err(snapshot_io_error)?;
        file.write_all(&bytes).map_err(snapshot_io_error)?;
        file.as_file().sync_all().map_err(snapshot_io_error)?;
        file.commit().map_err(snapshot_io_error)
    }

    #[cfg(test)]
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

fn is_valid_payload(payload: &BootstrapResponse) -> bool {
    payload.revision == payload.dashboard.revision
        && payload
            .first_page_by_panel
            .values()
            .all(|page| page.items.len() <= usize::from(FIRST_PAGE_SIZE))
}

fn checksum(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn snapshot_io_error(error: std::io::Error) -> ApiError {
    ApiError::internal(format!("Erreur du snapshot de démarrage: {error}"))
}

#[cfg(test)]
mod tests {
    use super::StartupSnapshotStore;
    use crate::model::{BootstrapResponse, DashboardState};
    use std::{collections::BTreeMap, fs};
    use uuid::Uuid;

    fn empty_bootstrap() -> BootstrapResponse {
        BootstrapResponse {
            session_id: Uuid::new_v4(),
            revision: 0,
            dashboard: DashboardState {
                layout: None,
                revision: 0,
            },
            panels: vec![],
            sources: vec![],
            first_page_by_panel: BTreeMap::new(),
        }
    }

    #[test]
    fn round_trips_and_rejects_corruption() {
        let directory = std::env::temp_dir().join(format!("vibedeck-snapshot-{}", Uuid::new_v4()));
        let store = StartupSnapshotStore::new(directory.join("startup.json"));
        let bootstrap = empty_bootstrap();
        store.save(&bootstrap).unwrap();
        assert_eq!(store.load().unwrap(), Some(bootstrap));

        fs::write(store.path(), b"{\"version\":1,\"checksum\":\"wrong\"}").unwrap();
        assert_eq!(store.load().unwrap(), None);
        fs::remove_dir_all(directory).unwrap();
    }
}
