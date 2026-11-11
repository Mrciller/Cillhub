//! Auto-update from the hub's feed (latest.yml / latest-linux.yml next to the installers; scripts/publish.js writes
//! them). The sha512 in the feed comes from the same server as the installer, so only the Ed25519 signature in
//! <installer>.sig, made with the self-host release key over "cillhub-desktop\n<version>\n<sha512 hex>\n", makes a
//! download trusted: an older signed installer cannot be served as a newer version. The pinned keys are compiled in.

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha512};
#[cfg(feature = "native-net")]
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const PINNED_KEYS: &str = include_str!("../../selfhost/release-public-key.pem");

pub struct Feed {
    pub version: String,
    pub files: Vec<String>,
}

pub fn parse_feed(yml: &str) -> Option<Feed> {
    let version = yml
        .lines()
        .find_map(|l| l.strip_prefix("version: "))
        .map(|v| v.trim().trim_matches('\'').to_string())?;
    let files = yml
        .lines()
        .filter_map(|l| l.trim().strip_prefix("- url: "))
        .map(|u| u.trim().to_string())
        .collect();
    Some(Feed { version, files })
}

fn semver(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.trim().split('.').map(|p| p.parse::<u64>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

pub fn is_newer(offered: &str, current: &str) -> bool {
    matches!((semver(offered), semver(current)), (Some(o), Some(c)) if o > c)
}

pub fn message(sha512_hex: &str, version: &str) -> Vec<u8> {
    format!("cillhub-desktop\n{version}\n{sha512_hex}\n").into_bytes()
}

pub fn parse_keys(pem: &str) -> Vec<VerifyingKey> {
    const ED25519_SPKI_PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    pem.split("-----BEGIN PUBLIC KEY-----")
        .skip(1)
        .filter_map(|block| {
            let b64: String = block
                .split("-----END PUBLIC KEY-----")
                .next()?
                .split_whitespace()
                .collect();
            let der = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
            let raw = der.strip_prefix(&ED25519_SPKI_PREFIX)?;
            VerifyingKey::from_bytes(raw.try_into().ok()?).ok()
        })
        .collect()
}

pub fn verify(sha512_hex: &str, version: &str, sig: &[u8], keys_pem: &str) -> bool {
    let Ok(sig) = Signature::from_slice(sig) else {
        return false;
    };
    let msg = message(sha512_hex, version);
    parse_keys(keys_pem)
        .iter()
        .any(|k| k.verify(&msg, &sig).is_ok())
}

pub fn sha512_hex(path: &Path) -> std::io::Result<String> {
    let mut h = Sha512::new();
    std::io::copy(&mut std::fs::File::open(path)?, &mut h)?;
    Ok(hex(&h.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(feature = "native-net")]
pub fn download(
    client: &reqwest::blocking::Client,
    url: &str,
    dest: &Path,
    mut progress: impl FnMut(u32),
) -> Result<String, String> {
    let mut resp = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut h = Sha512::new();
    let mut buf = [0u8; 64 * 1024];
    let (mut done, mut last) = (0u64, u32::MAX);
    loop {
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        h.update(&buf[..n]);
        done += n as u64;
        let pct = if total > 0 {
            (done * 100 / total) as u32
        } else {
            0
        };
        if pct != last {
            last = pct;
            progress(pct);
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(hex(&h.finalize()))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Package {
    Nsis,
    AppImage(PathBuf),
    Deb,
}

pub fn package() -> Option<Package> {
    if cfg!(windows) {
        return Some(Package::Nsis);
    }
    if let Some(p) = std::env::var_os("APPIMAGE") {
        return Some(Package::AppImage(PathBuf::from(p)));
    }
    std::env::current_exe()
        .ok()
        .filter(|e| e.starts_with("/usr"))
        .map(|_| Package::Deb)
}

pub fn pick_file<'a>(feed: &'a Feed, pkg: &Package) -> Option<&'a str> {
    let want = match pkg {
        Package::Nsis => ".exe",
        Package::AppImage(_) => ".AppImage",
        Package::Deb => ".deb",
    };
    feed.files
        .iter()
        .find(|f| f.ends_with(want) && !f.contains(['/', '\\', ':']) && !f.starts_with('.'))
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn pem(k: &SigningKey) -> String {
        let mut der = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        der.extend_from_slice(k.verifying_key().as_bytes());
        format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
            base64::engine::general_purpose::STANDARD.encode(der)
        )
    }

    #[test]
    fn signature_pinned_key_same_file_same_version() {
        let mut rng = rand::rngs::OsRng;
        let (pinned, other, evil) = (
            SigningKey::generate(&mut rng),
            SigningKey::generate(&mut rng),
            SigningKey::generate(&mut rng),
        );
        let keys = pem(&other) + &pem(&pinned);
        let file =
            std::env::temp_dir().join(format!("Cillhub-Setup-3.0.0-{}.exe", std::process::id()));
        std::fs::write(&file, b"installer bytes").unwrap();
        let sha = sha512_hex(&file).unwrap();
        let sig = pinned.sign(&message(&sha, "3.0.0")).to_bytes();

        assert!(verify(&sha, "3.0.0", &sig, &keys));
        assert!(!verify(&sha, "3.1.0", &sig, &keys));
        assert!(!verify(
            &sha,
            "3.0.0",
            &evil.sign(&message(&sha, "3.0.0")).to_bytes(),
            &keys
        ));
        assert!(!verify(&sha, "3.0.0", &sig, ""));
        assert!(!verify(&sha, "3.0.0", &sig, PINNED_KEYS));
        assert!(!verify(&sha, "3.0.0", &sig[..60], &keys));
        std::fs::write(&file, b"installer bytes!").unwrap();
        assert!(!verify(&sha512_hex(&file).unwrap(), "3.0.0", &sig, &keys));
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn pinned_keys_parse() {
        assert_eq!(
            parse_keys(PINNED_KEYS).len(),
            PINNED_KEYS.matches("BEGIN PUBLIC KEY").count()
        );
        assert!(!parse_keys(PINNED_KEYS).is_empty());
        assert!(parse_keys("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----").is_empty());
    }

    #[test]
    fn feed_and_versions() {
        let yml = "version: 3.0.1\nfiles:\n  - url: Cillhub-3.0.1.AppImage\n    sha512: x\n    size: 1\n  - url: cillhub_3.0.1_amd64.deb\n    sha512: y\n    size: 2\npath: Cillhub-3.0.1.AppImage\nsha512: x\nreleaseDate: '2026-11-10T00:00:00.000Z'\n";
        let feed = parse_feed(yml).unwrap();
        assert_eq!(feed.version, "3.0.1");
        assert_eq!(
            pick_file(&feed, &Package::AppImage("/x".into())),
            Some("Cillhub-3.0.1.AppImage")
        );
        assert_eq!(
            pick_file(&feed, &Package::Deb),
            Some("cillhub_3.0.1_amd64.deb")
        );
        assert_eq!(pick_file(&feed, &Package::Nsis), None);
        assert!(parse_feed("files: []").is_none());
        for evil in [
            "../../x.deb",
            "/tmp/x.deb",
            "C:\\x.deb",
            "https://evil/x.deb",
            ".deb",
        ] {
            assert_eq!(
                pick_file(
                    &Feed {
                        version: "9.0.0".into(),
                        files: vec![evil.into()]
                    },
                    &Package::Deb
                ),
                None,
                "{evil}"
            );
        }
        assert!(is_newer("3.0.1", "3.0.0") && is_newer("3.1.0", "3.0.9") && is_newer("10.0.0", "9.9.9"));
        assert!(!is_newer("3.0.0", "3.0.0") && !is_newer("2.9.9", "3.0.0") && !is_newer("dev", "3.0.0") && !is_newer("3.0", "3.0.0"));
    }
}
