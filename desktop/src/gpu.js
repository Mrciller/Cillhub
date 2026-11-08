// GPU screen sharing on Windows: Windows Graphics Capture for screens/windows and hardware H.264 and AV1 encoding (Media Foundation)
// for WebRTC. Applied before app ready; the desktop setting "Use the GPU for screen sharing" (gpuScreenShare, default on)
// leaves the switches out after a restart. Hardware acceleration itself is never turned off.
// Checked against Chromium 156.0.8078.75 (Electron 45.2.1):
// - WGC needs no flag any more: window capture always uses it, screen capture on Windows 11 24H2+ (older: DXGI duplication).
//   The old WebRtcAllowWgc*Capturer features were removed after M140.
// - Hardware encoding (webrtc-hw-encoding, MediaFoundationVideoEncodeAccelerator) is on by default, but on Windows the MF
//   encoder does not offer H.264 Constrained Baseline (42e01f), the profile WebRTC negotiates, unless this is enabled
//   (third_party/blink/renderer/platform/peerconnection/webrtc_util.cc). Without it H.264 falls back to OpenH264.
// - AV1: WebRTC leaves the MF AV1 encoder (NVIDIA RTX 40/50, AMD RX 7000+, Intel Arc and newer iGPUs) unused on Windows
//   unless WebRtcAV1HWEncode is on (media/webrtc/webrtc_features.cc: disabled by default on Windows only;
//   third_party/blink/renderer/platform/peerconnection/rtc_video_encoder_factory.cc drops the AV1 profiles without it).
//   With it, mediaCapabilities reports AV1 as powerEfficient on those GPUs and the client's Auto picks AV1. A GPU without an
//   AV1 encoder reports no AV1 profile, so the switch changes nothing there.
const FEATURES = ['PlatformH264CbpEncoding', 'WebRtcAV1HWEncode'];

/** Appends the switches when wanted; returns whether hardware encoding is switched on (window.cillcordDesktop.hwEncode). */
function apply(app, wanted, platform = process.platform) {
  if (!wanted || platform !== 'win32' || !FEATURES.length) return false;
  app.commandLine.appendSwitch('enable-features', FEATURES.join(','));
  return true;
}

module.exports = { FEATURES, apply };
