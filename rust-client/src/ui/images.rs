//! Remote images: a few fixed workers, a byte limit while streaming, a size check on the image header, and a
//! bounded cache that tells egui to drop the oldest images.
use std::collections::VecDeque;
use std::io::Read;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

/// The hub's attachment limit is set per instance (1-100 MiB) and this app does not read it; 25 MB covers the
/// default and anything worth showing inline.
pub const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
/// egui textures are limited to this on common GPUs; a larger picture is not decoded at all.
pub const MAX_IMAGE_SIDE: u32 = 8192;
/// Decoded RGBA is 4 bytes a pixel: 16 MP is 64 MiB. A larger picture is not decoded at all.
pub const MAX_IMAGE_PIXELS: u64 = 16 * 1024 * 1024;
const WORKERS: usize = 4;
const CACHE_BYTES: usize = 256 * 1024 * 1024;
const CACHE_COUNT: usize = 300;

/// A finished image job: the session it was asked in, its uri, and the bytes with their cache cost (or None).
pub type Done = (u64, String, Option<(Vec<u8>, usize)>);

/// An image job: (session, uri, url, pinned). A pinned job (a private node's media) follows no redirect: the
/// address was checked to be on the node's own origin and must stay there.
pub type Job = (u64, String, String, bool);

/// Starts the workers. Send jobs; the result comes back on `done`.
pub fn spawn_workers(done: mpsc::Sender<Done>) -> mpsc::Sender<Job> {
    let (tx, rx) = mpsc::channel::<Job>();
    let rx = Arc::new(Mutex::new(rx));
    for _ in 0..WORKERS {
        let (rx, done) = (rx.clone(), done.clone());
        std::thread::spawn(move || {
            // its own client: image requests never carry the hub token
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("TLS backend");
            let pinned_client = crate::api::no_redirect_client(30);
            loop {
                let Ok(Ok((session, uri, url, pinned))) = rx.lock().map(|r| r.recv()) else { return };
                let bytes = fetch(if pinned { &pinned_client } else { &client }, &url).and_then(|b| check(&b).map(|n| (b, n)));
                if let Err(e) = &bytes {
                    eprintln!("cillhub: image {url}: {e}");
                }
                if done.send((session, uri, bytes.ok())).is_err() {
                    return; // the app has closed
                }
            }
        });
    }
    tx
}

pub fn fetch(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("answer {}", resp.status())); // a redirect the client did not follow
    }
    if resp.content_length().is_some_and(|n| n > MAX_IMAGE_BYTES) {
        return Err("image too large".into());
    }
    let mut bytes = Vec::new();
    resp.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("image too large".into());
    }
    Ok(bytes)
}

/// Reads only the header: a small file can still claim a huge picture. Returns what the image costs the cache:
/// the file egui keeps plus its decoded pixels (a padded file can be large and decode to almost nothing).
pub fn check(bytes: &[u8]) -> Result<usize, String> {
    let (w, h) = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .into_dimensions()
        .map_err(|e| e.to_string())?;
    if w == 0 || h == 0 || w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE || w as u64 * h as u64 > MAX_IMAGE_PIXELS {
        return Err(format!("image is {w}x{h}"));
    }
    (w as usize)
        .checked_mul(h as usize)
        .and_then(|p| p.checked_mul(4))
        .and_then(|d| d.checked_add(bytes.len()))
        .ok_or_else(|| "image too large".to_string())
}

/// Loaded images, oldest first. Past the limits the oldest go (egui frees them; a later view loads them again).
#[derive(Default)]
pub struct Cache {
    order: VecDeque<(String, usize)>,
    bytes: usize,
}

impl Cache {
    /// Adds an image and returns the uris to forget.
    pub fn add(&mut self, uri: String, len: usize) -> Vec<String> {
        self.bytes += len;
        self.order.push_back((uri, len));
        let mut out = Vec::new();
        while self.order.len() > 1 && (self.bytes > CACHE_BYTES || self.order.len() > CACHE_COUNT) {
            if let Some((u, n)) = self.order.pop_front() {
                self.bytes -= n;
                out.push(u);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_header(w: u32, h: u32) -> Vec<u8> {
        fn crc(data: &[u8]) -> u32 {
            let mut c = 0xffff_ffffu32;
            for &b in data {
                c ^= b as u32;
                for _ in 0..8 {
                    c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
                }
            }
            !c
        }
        let chunk = |png: &mut Vec<u8>, body: Vec<u8>| {
            png.extend_from_slice(&(body.len() as u32 - 4).to_be_bytes());
            png.extend_from_slice(&body);
            png.extend_from_slice(&crc(&body).to_be_bytes());
        };
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        chunk(&mut png, [&b"IHDR"[..], &w.to_be_bytes(), &h.to_be_bytes(), &[8, 6, 0, 0, 0]].concat());
        chunk(&mut png, b"IDAT".to_vec());
        png
    }

    #[test]
    fn header_size_and_byte_limits() {
        let small = png_header(400, 300);
        assert_eq!(check(&small), Ok(400 * 300 * 4 + small.len()));
        assert!(check(&png_header(8192, 8192)).is_err(), "within the side limit, but 256 MiB decoded");
        let big = png_header(4096, 4096);
        assert_eq!(check(&big), Ok((64 << 20) + big.len()));
        let mut padded = png_header(1, 1);
        padded.resize(20 << 20, 0); // a 1x1 picture padded to 20 MiB costs its file, not 4 bytes
        assert_eq!(check(&padded), Ok(4 + (20 << 20)));
        assert!(check(&png_header(100_000, 100_000)).is_err());
        assert!(check(b"not an image").is_err());

        use std::io::Write;
        let mut req = [0u8; 2048];
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let _ = sock.read(&mut req);
            let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n");
            let chunk = vec![0u8; 1 << 20];
            for _ in 0..(MAX_IMAGE_BYTES >> 20) + 2 {
                if sock.write_all(&chunk).is_err() {
                    break;
                }
            }
        });
        let client = reqwest::blocking::Client::new();
        assert_eq!(fetch(&client, &format!("http://127.0.0.1:{port}/big.png")), Err("image too large".into()));
        drop(client);
        let _ = server.join();
    }

    #[test]
    fn cache_drops_the_oldest() {
        let mut c = Cache::default();
        assert!(c.add("a".into(), CACHE_BYTES / 2).is_empty());
        assert!(c.add("b".into(), CACHE_BYTES / 2).is_empty());
        assert_eq!(c.add("c".into(), 10), vec!["a".to_string()]);
        for i in 0..CACHE_COUNT {
            c.add(format!("x{i}"), 1);
        }
        assert!(c.order.len() <= CACHE_COUNT && c.bytes <= CACHE_BYTES);
    }
}
