//! Auto-update from the hub's native feed (native-latest.yml / native-latest-linux.yml next to the installers;
//! desktop-rust/scripts/publish.js writes them). The sha512 in the feed comes from the same server as the installer, so
//! only the Ed25519 signature in <installer>.sig, made with the self-host release key over
//! "cillhub-native\n<version>\n<sha512 hex>\n", makes a download trusted: an older signed installer cannot be served as
//! a newer version, and an installer of the old desktop app (signed over "cillhub-desktop\n…") never verifies here.
//! The pinned keys are compiled in.

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
    /// (file, base64 sha512) from each `files` entry.
    pub digests: Vec<(String, String)>,
}

pub fn parse_feed(yml: &str) -> Option<Feed> {
    let version = yml
        .lines()
        .find_map(|l| l.strip_prefix("version: "))
        .map(|v| v.trim().trim_matches('\'').to_string())?;
    let (mut files, mut digests) = (Vec::new(), Vec::new());
    for line in yml.lines() {
        if let Some(u) = line.trim().strip_prefix("- url: ") {
            files.push(u.trim().to_string());
        } else if let (Some(d), true) = (line.trim().strip_prefix("sha512: "), line.starts_with(' ')) {
            if let Some(f) = files.last() {
                digests.push((f.clone(), d.trim().to_string()));
            }
        }
    }
    Some(Feed { version, files, digests })
}

/// The last gate before an installer may run: newer than this build, same sha512 as the feed
/// lists, and signed with a pinned key over (version, sha512).
pub fn accept(
    feed: &Feed,
    file: &str,
    sha512_hex: &str,
    sig: &[u8],
    keys_pem: &str,
    current: &str,
) -> Result<(), String> {
    if !is_newer(&feed.version, current) {
        return Err(format!("{} is not newer than {current}", feed.version));
    }
    let listed = feed
        .digests
        .iter()
        .find(|(f, _)| f == file)
        .map(|(_, d)| d.as_str())
        .ok_or("feed lists no sha512 for the installer")?;
    let bytes: Vec<u8> = (0..sha512_hex.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(sha512_hex.get(i..i + 2)?, 16).ok())
        .collect();
    if base64::engine::general_purpose::STANDARD.encode(bytes) != listed {
        return Err("downloaded installer does not match the feed's sha512".into());
    }
    if !verify(sha512_hex, &feed.version, sig, keys_pem) {
        return Err("update signature does not verify against the pinned release keys".into());
    }
    Ok(())
}

/// A downloaded installer and what it was verified against, so it can be checked again right before it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Staged {
    pub version: String,
    pub path: PathBuf,
    pub sha512_hex: String,
    pub sig: Vec<u8>,
}

/// The staged file still has the digest that was verified, and the signature still holds for it.
pub fn verify_staged(staged: &Staged, keys_pem: &str) -> Result<(), String> {
    let now = sha512_hex(&staged.path).map_err(|e| e.to_string())?;
    if now != staged.sha512_hex {
        return Err("the downloaded installer changed after it was verified".into());
    }
    if !verify(&now, &staged.version, &staged.sig, keys_pem) {
        return Err("update signature does not verify against the pinned release keys".into());
    }
    Ok(())
}

/// A fresh directory only this user can enter (0700 on unix), with a random name: an existing path is never reused.
pub fn private_dir(parent: &Path) -> std::io::Result<PathBuf> {
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    let mut rnd = [0u8; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut rnd)
        .map_err(|_| std::io::Error::other("no random source"))?;
    let dir = parent.join(format!("cillhub-update-{}", hex(&rnd)));
    b.create(&dir)?; // fails if the path exists
    Ok(dir)
}

/// Checks `<base>latest[-linux].yml`; downloads and verifies a newer installer for this package.
/// Ok(None) = nothing to do (up to date, or a build no updater can replace, e.g. the tarball).
#[cfg(feature = "native-net")]
pub fn fetch_update(base: &str, current: &str) -> Result<Option<Staged>, String> {
    let Some(pkg) = package() else { return Ok(None) };
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(None)
        .build()
        .map_err(|e| e.to_string())?;
    let get = |url: String| {
        client
            .get(url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| e.to_string())
    };
    let feed_name = if cfg!(windows) { "native-latest.yml" } else { "native-latest-linux.yml" };
    let yml = get(format!("{base}{feed_name}"))?.text().map_err(|e| e.to_string())?;
    let feed = parse_feed(&yml).ok_or("feed has no version")?;
    if !is_newer(&feed.version, current) {
        return Ok(None);
    }
    let file = pick_file(&feed, &pkg)
        .ok_or("feed lists no installer for this package")?
        .to_string();
    let dir = private_dir(&std::env::temp_dir()).map_err(|e| e.to_string())?;
    let dest = dir.join(&file);
    let sha = download(&client, &format!("{base}{file}"), &dest, |_| {});
    let sig = sha.and_then(|sha| {
        let sig = get(format!("{base}{file}.sig"))?.bytes().map_err(|e| e.to_string())?;
        accept(&feed, &file, &sha, &sig, PINNED_KEYS, current).map(|_| (sha, sig.to_vec()))
    });
    match sig {
        Ok((sha512_hex, sig)) => Ok(Some(Staged { version: feed.version, path: dest, sha512_hex, sig })),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir); // never keep an unverified installer around
            Err(e)
        }
    }
}

/// Runs as root through pkexec with the staged package ($1) and its signed SHA-512 ($2): copies it into a
/// root-only directory, checks that copy against the hash and installs only that copy, so the user-writable
/// file cannot be swapped between the app's check and dpkg.
pub const DEB_INSTALL: &str = r#"set -e
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
cp -- "$1" "$t/update.deb"
echo "$2  $t/update.deb" | sha512sum -c --status
/usr/bin/dpkg -i "$t/update.deb""#;

/// Runs a staged installer after checking it once more. The caller exits afterwards (the installer relaunches the app).
pub fn run_installer(staged: &Staged) -> std::io::Result<()> {
    use std::process::Command;
    verify_staged(staged, PINNED_KEYS).map_err(std::io::Error::other)?;
    let path = staged.path.as_path();
    match package() {
        // the NSIS script's update path: silent, then it starts the app again (--force-run). Untested here (no Windows).
        Some(Package::Nsis) => Command::new(path).args(["/S", "--force-run"]).spawn().map(|_| ()),
        Some(Package::AppImage(image)) => {
            #[cfg(unix)]
            std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
            std::fs::rename(path, &image)?;
            Command::new(image).spawn().map(|_| ())
        }
        Some(Package::Deb) => {
            // before dpkg: afterwards /proc/self/exe names the replaced, deleted file
            let exe = std::env::current_exe()?;
            let s = Command::new("pkexec")
                .args(["/bin/sh", "-c", DEB_INSTALL, "sh"])
                .arg(path)
                .arg(&staged.sha512_hex)
                .status()?;
            if !s.success() {
                return Err(std::io::Error::other(format!("dpkg: {s}")));
            }
            Command::new(exe).spawn().map(|_| ())
        }
        None => Err(std::io::Error::other("no installer for this build")),
    }
}

fn semver(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.trim().split('.').map(|p| p.parse::<u64>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

pub fn is_newer(offered: &str, current: &str) -> bool {
    matches!((semver(offered), semver(current)), (Some(o), Some(c)) if o > c)
}

pub fn message(sha512_hex: &str, version: &str) -> Vec<u8> {
    format!("cillhub-native\n{version}\n{sha512_hex}\n").into_bytes()
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
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true); // never follows or reuses an existing file
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let mut file = opts.open(dest).map_err(|e| e.to_string())?;
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
    // only this app's artifacts (publish.js names); no AppImage of it exists
    let (prefix, suffix) = match pkg {
        Package::Nsis => ("Cillhub-Rust-Setup-", ".exe"),
        Package::AppImage(_) => return None,
        Package::Deb => ("cillhub-desktop-rust_", "_amd64.deb"),
    };
    feed.files
        .iter()
        .find(|f| f.starts_with(prefix) && f.ends_with(suffix) && !f.contains(['/', '\\', ':']))
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deb_install_checks_its_own_copy() {
        let dir = private_dir(&std::env::temp_dir()).unwrap();
        let deb = dir.join("x.deb");
        std::fs::write(&deb, b"package bytes").unwrap();
        let good = hex(&Sha512::digest(b"package bytes"));
        // dpkg replaced by a check that the root-only copy exists
        let script = DEB_INSTALL.replace("/usr/bin/dpkg -i", "test -s");
        let run = |hash: &str| std::process::Command::new("/bin/sh").args(["-c", &script, "sh"]).arg(&deb).arg(hash).status().unwrap().success();
        assert!(run(&good));
        assert!(!run(&"0".repeat(128)), "a copy with another hash is not installed");
        std::fs::remove_dir_all(dir).unwrap();
    }
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
    fn accept_checks_version_digest_and_signature() {
        let mut rng = rand::rngs::OsRng;
        let (pinned, evil) = (SigningKey::generate(&mut rng), SigningKey::generate(&mut rng));
        let keys = pem(&pinned);
        let installer = b"installer bytes";
        let sha = hex(&Sha512::digest(installer));
        let b64 = base64::engine::general_purpose::STANDARD.encode(Sha512::digest(installer));
        let yml = format!("version: 3.1.0\nfiles:\n  - url: cillhub_3.1.0_amd64.deb\n    sha512: {b64}\n    size: 15\npath: cillhub_3.1.0_amd64.deb\nsha512: other\n");
        let feed = parse_feed(&yml).unwrap();
        let file = "cillhub_3.1.0_amd64.deb";
        let sig = pinned.sign(&message(&sha, "3.1.0")).to_bytes();

        assert_eq!(accept(&feed, file, &sha, &sig, &keys, "3.0.2"), Ok(()));
        // bad signature: other key, or signed for another version
        let bad = evil.sign(&message(&sha, "3.1.0")).to_bytes();
        assert!(accept(&feed, file, &sha, &bad, &keys, "3.0.2").unwrap_err().contains("signature"));
        let old = pinned.sign(&message(&sha, "3.0.9")).to_bytes();
        assert!(accept(&feed, file, &sha, &old, &keys, "3.0.2").is_err());
        // bad digest: the bytes that arrived are not the ones the feed lists (even if signed)
        let other = hex(&Sha512::digest(b"tampered"));
        let other_sig = pinned.sign(&message(&other, "3.1.0")).to_bytes();
        assert!(accept(&feed, file, &other, &other_sig, &keys, "3.0.2").unwrap_err().contains("sha512"));
        // downgrade and same version refused
        assert!(accept(&feed, file, &sha, &sig, &keys, "3.1.0").is_err());
        assert!(accept(&feed, file, &sha, &sig, &keys, "4.0.0").unwrap_err().contains("not newer"));
        // a file the feed does not list
        assert!(accept(&feed, "x.deb", &sha, &sig, &keys, "3.0.2").is_err());
    }

    #[test]
    fn staged_installer_is_checked_again_before_it_runs() {
        let mut rng = rand::rngs::OsRng;
        let key = SigningKey::generate(&mut rng);
        let dir = private_dir(&std::env::temp_dir()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        assert_ne!(private_dir(&std::env::temp_dir()).map(|d| { let _ = std::fs::remove_dir(&d); d }).unwrap(), dir);
        let path = dir.join("cillhub-desktop-rust_3.1.0_amd64.deb");
        std::fs::write(&path, b"installer bytes").unwrap();
        let sha = sha512_hex(&path).unwrap();
        let staged = Staged { version: "3.1.0".into(), path: path.clone(), sha512_hex: sha.clone(), sig: key.sign(&message(&sha, "3.1.0")).to_bytes().to_vec() };
        assert_eq!(verify_staged(&staged, &pem(&key)), Ok(()));
        assert!(verify_staged(&staged, PINNED_KEYS).is_err());
        std::fs::write(&path, b"swapped bytes!!").unwrap();
        assert!(verify_staged(&staged, &pem(&key)).unwrap_err().contains("changed"));
        assert!(run_installer(&staged).is_err());
        let _ = std::fs::remove_dir_all(dir);
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
        let yml = "version: 3.0.1\nfiles:\n  - url: Cillhub-3.0.1.AppImage\n    sha512: x\n    size: 1\n  - url: cillhub_3.0.1_amd64.deb\n    sha512: y\n    size: 2\n  - url: cillhub-desktop-rust_3.0.1_amd64.deb\n    sha512: z\n    size: 3\n  - url: Cillhub-Setup-3.0.1.exe\n    sha512: w\n    size: 4\npath: Cillhub-3.0.1.AppImage\nsha512: x\nreleaseDate: '2026-11-10T00:00:00.000Z'\n";
        let feed = parse_feed(yml).unwrap();
        assert_eq!(feed.version, "3.0.1");
        // the old desktop app's artifacts are never picked
        assert_eq!(pick_file(&feed, &Package::AppImage("/x".into())), None);
        assert_eq!(pick_file(&feed, &Package::Deb), Some("cillhub-desktop-rust_3.0.1_amd64.deb"));
        assert_eq!(pick_file(&feed, &Package::Nsis), None);
        assert_eq!(message("ab", "3.0.1"), b"cillhub-native\n3.0.1\nab\n");
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
                        files: vec![evil.into()],
                        digests: vec![],
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
