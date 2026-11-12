//! Audio subsystem with real-time DSP filters and neural noise reduction

pub mod denoise_rnnoise;
pub mod filters;
pub mod pipeline;

pub use pipeline::{AudioConfig, AudioMetrics, AudioPipeline};
