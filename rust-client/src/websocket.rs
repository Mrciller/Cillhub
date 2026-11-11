//! Minimal RFC 6455 framing for the Cillhub JSON gateway. The network runtime
//! supplies TLS, random handshake/mask bytes, and reconnect scheduling.
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::digest::{digest, SHA1_FOR_LEGACY_USE_ONLY};

const GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

pub fn handshake_key(nonce: [u8; 16]) -> String {
    STANDARD.encode(nonce)
}

pub fn expected_accept(key: &str) -> String {
    let mut input = Vec::with_capacity(key.len() + GUID.len());
    input.extend_from_slice(key.as_bytes());
    input.extend_from_slice(GUID);
    STANDARD.encode(digest(&SHA1_FOR_LEGACY_USE_ONLY, &input).as_ref())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Opcode { Continuation, Text, Binary, Close, Ping, Pong }

impl Opcode {
    fn code(self) -> u8 {
        match self { Self::Continuation => 0, Self::Text => 1, Self::Binary => 2, Self::Close => 8, Self::Ping => 9, Self::Pong => 10 }
    }
    fn from_code(code: u8) -> Result<Self, FrameError> {
        match code { 0 => Ok(Self::Continuation), 1 => Ok(Self::Text), 2 => Ok(Self::Binary), 8 => Ok(Self::Close), 9 => Ok(Self::Ping), 10 => Ok(Self::Pong), _ => Err(FrameError::Opcode) }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame { pub opcode: Opcode, pub final_fragment: bool, pub payload: Vec<u8> }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameError { Opcode, MaskedServerFrame, Oversized, InvalidControlFrame }

/// Encode one masked client frame. The caller must supply a fresh unpredictable mask.
pub fn encode_client_frame(opcode: Opcode, payload: &[u8], mask: [u8; 4]) -> Result<Vec<u8>, FrameError> {
    if payload.len() > MAX_FRAME_BYTES { return Err(FrameError::Oversized); }
    if opcode.code() >= 8 && payload.len() > 125 { return Err(FrameError::InvalidControlFrame); }
    let mut out = vec![0x80 | opcode.code()];
    match payload.len() {
        0..=125 => out.push(0x80 | payload.len() as u8),
        126..=65535 => { out.push(0x80 | 126); out.extend_from_slice(&(payload.len() as u16).to_be_bytes()); }
        _ => { out.push(0x80 | 127); out.extend_from_slice(&(payload.len() as u64).to_be_bytes()); }
    }
    out.extend_from_slice(&mask);
    out.extend(payload.iter().enumerate().map(|(i, byte)| byte ^ mask[i % 4]));
    Ok(out)
}

/// Decode an unmasked server frame. `None` means more input is needed.
pub fn decode_server_frame(input: &[u8]) -> Result<Option<(Frame, usize)>, FrameError> {
    if input.len() < 2 { return Ok(None); }
    let final_fragment = input[0] & 0x80 != 0;
    let opcode = Opcode::from_code(input[0] & 0x0f)?;
    if input[1] & 0x80 != 0 { return Err(FrameError::MaskedServerFrame); }
    let mut header = 2;
    let marker = input[1] & 0x7f;
    let length = match marker {
        0..=125 => marker as u64,
        126 => { if input.len() < 4 { return Ok(None); } header = 4; u16::from_be_bytes([input[2], input[3]]) as u64 },
        _ => { if input.len() < 10 { return Ok(None); } header = 10; u64::from_be_bytes(input[2..10].try_into().unwrap()) },
    };
    if length > MAX_FRAME_BYTES as u64 { return Err(FrameError::Oversized); }
    if opcode.code() >= 8 && (!final_fragment || length > 125) { return Err(FrameError::InvalidControlFrame); }
    let end = header + length as usize;
    if input.len() < end { return Ok(None); }
    Ok(Some((Frame { opcode, final_fragment, payload: input[header..end].to_vec() }, end)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc_handshake_vector() {
        assert_eq!(expected_accept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn masked_client_text_and_server_frames() {
        assert_eq!(encode_client_frame(Opcode::Text, b"Hi", [0x37, 0xfa, 0x21, 0x3d]).unwrap(), vec![0x81, 0x82, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x93]);
        assert_eq!(decode_server_frame(&[0x81, 0x05, b'H', b'e', b'l', b'l', b'o']).unwrap(), Some((Frame { opcode: Opcode::Text, final_fragment: true, payload: b"Hello".to_vec() }, 7)));
        assert_eq!(decode_server_frame(&[0x81, 0x05, b'H']).unwrap(), None);
        assert_eq!(decode_server_frame(&[0x81, 0x80]), Err(FrameError::MaskedServerFrame));
    }

    #[test]
    fn extended_lengths_and_limits() {
        let payload = vec![b'x'; 200];
        let encoded = encode_client_frame(Opcode::Text, &payload, [1, 2, 3, 4]).unwrap();
        assert_eq!(&encoded[..4], &[0x81, 0xfe, 0, 200]);
        let mut server = vec![0x81, 126, 0, 200];
        server.extend_from_slice(&payload);
        assert_eq!(decode_server_frame(&server).unwrap().unwrap().0.payload, payload);
        assert_eq!(decode_server_frame(&[0x89, 126, 0, 126]), Err(FrameError::InvalidControlFrame));
    }
}
