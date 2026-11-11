//! Blocking TCP/TLS WebSocket transport for native clients. A caller schedules
//! gateway heartbeats and reconnects; this module only owns one socket.
use crate::websocket::{decode_server_frame, encode_client_frame, expected_accept, handshake_key, Frame, Opcode};
use rustls::{pki_types::ServerName, ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use std::{io::{self, Read, Write}, net::TcpStream, sync::Arc, time::Duration};
use url::Url;

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

pub struct WebSocket {
    stream: Box<dyn ReadWrite>,
    buffer: Vec<u8>,
}

impl WebSocket {
    /// Connect to the exact gateway URL returned by GET /api/v9/gateway.
    pub fn connect(url: &Url) -> io::Result<Self> {
        if !matches!(url.scheme(), "wss" | "ws") { return Err(invalid("Unsupported WebSocket scheme")); }
        let host = url.host_str().ok_or_else(|| invalid("Missing WebSocket host"))?;
        if url.scheme() == "ws" && host != "localhost" && host != "127.0.0.1" && host != "[::1]" && !host.ends_with(".localhost") {
            return Err(invalid("Unencrypted WebSocket is only permitted on loopback"));
        }
        let port = url.port_or_known_default().ok_or_else(|| invalid("Missing WebSocket port"))?;
        let tcp = TcpStream::connect((host.trim_matches(['[', ']']), port))?;
        tcp.set_read_timeout(Some(Duration::from_secs(10)))?;
        tcp.set_write_timeout(Some(Duration::from_secs(10)))?;
        let tcp_ctrl = tcp.try_clone().ok();
        let stream: Box<dyn ReadWrite> = if url.scheme() == "wss" {
            let mut roots = RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let config = ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
            let name = ServerName::try_from(host.to_owned()).map_err(|_| invalid("Invalid TLS host"))?;
            let connection = ClientConnection::new(Arc::new(config), name).map_err(io::Error::other)?;
            Box::new(StreamOwned::new(connection, tcp))
        } else { Box::new(tcp) };
        let mut socket = Self { stream, buffer: Vec::new() };
        socket.upgrade(url)?;
        if let Some(ctrl) = tcp_ctrl {
            let _ = ctrl.set_read_timeout(Some(Duration::from_millis(250)));
        }
        Ok(socket)
    }

    fn upgrade(&mut self, url: &Url) -> io::Result<()> {
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).map_err(|e| io::Error::other(e.to_string()))?;
        let key = handshake_key(nonce);
        let mut path = url.path().to_string();
        if path.is_empty() { path.push('/'); }
        if let Some(query) = url.query() { path.push('?'); path.push_str(query); }
        let authority = if let Some(port) = url.port() { format!("{}:{port}", url.host_str().unwrap()) } else { url.host_str().unwrap().to_owned() };
        write!(self.stream, "GET {path} HTTP/1.1\r\nHost: {authority}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")?;
        self.stream.flush()?;
        while !self.buffer.windows(4).any(|w| w == b"\r\n\r\n") {
            if self.buffer.len() >= 16 * 1024 { return Err(invalid("WebSocket upgrade headers too large")); }
            let mut chunk = [0u8; 1024];
            let n = self.stream.read(&mut chunk)?;
            if n == 0 { return Err(io::Error::from(io::ErrorKind::UnexpectedEof)); }
            self.buffer.extend_from_slice(&chunk[..n]);
        }
        let header_end = self.buffer.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        let headers = std::str::from_utf8(&self.buffer[..header_end]).map_err(|_| invalid("Invalid upgrade headers"))?;
        let mut lines = headers.split("\r\n");
        if !lines.next().is_some_and(|line| line.starts_with("HTTP/1.1 101 ")) { return Err(invalid("WebSocket upgrade rejected")); }
        let mut accept = None;
        let mut upgrade = false;
        let mut connection = false;
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                let value = value.trim();
                if name.eq_ignore_ascii_case("sec-websocket-accept") { accept = Some(value); }
                if name.eq_ignore_ascii_case("upgrade") { upgrade = value.eq_ignore_ascii_case("websocket"); }
                if name.eq_ignore_ascii_case("connection") { connection = value.split(',').any(|v| v.trim().eq_ignore_ascii_case("upgrade")); }
            }
        }
        if accept != Some(expected_accept(&key).as_str()) || !upgrade || !connection { return Err(invalid("Invalid WebSocket upgrade response")); }
        self.buffer.drain(..header_end);
        Ok(())
    }

    pub fn send(&mut self, opcode: Opcode, bytes: &[u8]) -> io::Result<()> {
        let mut mask = [0u8; 4];
        getrandom::getrandom(&mut mask).map_err(|e| io::Error::other(e.to_string()))?;
        let frame = encode_client_frame(opcode, bytes, mask).map_err(|_| invalid("Invalid client frame"))?;
        self.stream.write_all(&frame)?;
        self.stream.flush()
    }

    pub fn read_frame(&mut self) -> io::Result<Frame> {
        loop {
            match decode_server_frame(&self.buffer).map_err(|_| invalid("Invalid server frame"))? {
                Some((frame, count)) => { self.buffer.drain(..count); return Ok(frame); }
                None => {
                    let mut chunk = [0u8; 8192];
                    let n = self.stream.read(&mut chunk)?;
                    if n == 0 { return Err(io::Error::from(io::ErrorKind::UnexpectedEof)); }
                    self.buffer.extend_from_slice(&chunk[..n]);
                }
            }
        }
    }
}

fn invalid(message: &'static str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, message) }
