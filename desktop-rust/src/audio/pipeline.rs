//! 48 kHz Real-Time DSP Audio Pipeline

use crate::audio::denoise_rnnoise::{RnnoiseDenoiser, RNNOISE_FRAME_SIZE};
use crate::audio::filters::{GateState, HighPassFilter, HysteresisGate, PeakLimiter};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioConfig {
    #[serde(default = "default_true")]
    pub high_pass: bool,
    #[serde(default = "default_hp_cutoff")]
    pub high_pass_cutoff_hz: f32,
    #[serde(default = "default_true")]
    pub noise_gate: bool,
    #[serde(default = "default_open_threshold")]
    pub gate_open_threshold_db: f32,
    #[serde(default = "default_close_threshold")]
    pub gate_close_threshold_db: f32,
    #[serde(default = "default_rnnoise")]
    pub rnnoise_enabled: bool,
    #[serde(default = "default_true")]
    pub limiter_enabled: bool,
}

fn default_true() -> bool {
    true
}
fn default_hp_cutoff() -> f32 {
    80.0
}
fn default_open_threshold() -> f32 {
    -38.0
}
fn default_close_threshold() -> f32 {
    -46.0
}
fn default_rnnoise() -> bool {
    true
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            high_pass: true,
            high_pass_cutoff_hz: 80.0,
            noise_gate: true,
            gate_open_threshold_db: -38.0,
            gate_close_threshold_db: -46.0,
            rnnoise_enabled: true,
            limiter_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioMetrics {
    pub input_rms_dbfs: f32,
    pub output_rms_dbfs: f32,
    pub gate_state: String,
    pub gate_gain: f32,
}

pub struct AudioPipeline {
    high_pass: HighPassFilter,
    gate: HysteresisGate,
    rnnoise: RnnoiseDenoiser,
    limiter: PeakLimiter,
    limiter_enabled: bool,
}

impl AudioPipeline {
    pub fn new(sample_rate: u32, config: &AudioConfig) -> Self {
        let mut hp = HighPassFilter::new(sample_rate, config.high_pass_cutoff_hz);
        hp.set_enabled(config.high_pass);

        let mut gate = HysteresisGate::new(
            sample_rate,
            config.gate_open_threshold_db,
            config.gate_close_threshold_db,
            5.0,   // 5 ms attack
            150.0, // 150 ms hold
            40.0,  // 40 ms release
        );
        gate.set_enabled(config.noise_gate);

        let mut rnnoise = RnnoiseDenoiser::new();
        rnnoise.set_enabled(config.rnnoise_enabled);

        let limiter = PeakLimiter::new(-0.5);

        Self {
            high_pass: hp,
            gate,
            rnnoise,
            limiter,
            limiter_enabled: config.limiter_enabled,
        }
    }

    pub fn update_config(&mut self, config: &AudioConfig) {
        self.high_pass.set_enabled(config.high_pass);
        self.gate.set_enabled(config.noise_gate);
        self.rnnoise.set_enabled(config.rnnoise_enabled);
        self.limiter_enabled = config.limiter_enabled;
    }

    /// Process a 480-sample (10 ms) audio buffer
    pub fn process_frame(&mut self, frame: &mut [f32]) -> AudioMetrics {
        let in_rms = calculate_rms_dbfs(frame);

        // 1. 80 Hz High-pass rumble filter
        self.high_pass.process_buffer(frame);

        // 2. Hysteresis noise gate
        self.gate.process_frame(frame);
        let gate_state = match self.gate.state() {
            GateState::Open => "open",
            GateState::Holding => "holding",
            GateState::Closed => "closed",
        };
        let gate_gain = self.gate.current_gain();

        // 3. RNNoise neural denoiser
        if frame.len() == RNNOISE_FRAME_SIZE {
            self.rnnoise.process_frame(frame);
        }

        // 4. Peak limiter
        if self.limiter_enabled {
            self.limiter.process_buffer(frame);
        }

        let out_rms = calculate_rms_dbfs(frame);

        AudioMetrics {
            input_rms_dbfs: in_rms,
            output_rms_dbfs: out_rms,
            gate_state: gate_state.to_string(),
            gate_gain,
        }
    }
}

fn calculate_rms_dbfs(buffer: &[f32]) -> f32 {
    if buffer.is_empty() {
        return -100.0;
    }
    let mut sum = 0.0f32;
    for &s in buffer {
        sum += s * s;
    }
    let rms = (sum / buffer.len() as f32).sqrt();
    if rms < 1e-5 {
        -100.0
    } else {
        (20.0 * rms.log10()).max(-100.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_high_pass_attenuation() {
        let mut hp = HighPassFilter::new(48000, 80.0);
        // Feed 20 Hz low frequency tone
        let mut low_tone = vec![0.0f32; 4800];
        for (i, s) in low_tone.iter_mut().enumerate() {
            *s = (2.0 * std::f32::consts::PI * 20.0 * (i as f32) / 48000.0).sin();
        }
        let in_rms = calculate_rms_dbfs(&low_tone);
        hp.process_buffer(&mut low_tone);
        let out_rms = calculate_rms_dbfs(&low_tone);

        // 20 Hz should be significantly attenuated (>15 dB reduction)
        assert!(out_rms < in_rms - 15.0, "Expected >15 dB cut, got in={} out={}", in_rms, out_rms);
    }

    #[test]
    fn test_pipeline_noise_gate_and_rnnoise() {
        let config = AudioConfig::default();
        let mut pipeline = AudioPipeline::new(48000, &config);

        // Feed quiet noise below close threshold (-50 dBFS)
        let mut quiet = vec![0.003f32; 480];
        let metrics = pipeline.process_frame(&mut quiet);
        assert_eq!(metrics.gate_state, "closed");

        // Feed loud signal above open threshold (-20 dBFS)
        let mut loud = vec![0.1f32; 480];
        let metrics2 = pipeline.process_frame(&mut loud);
        assert_eq!(metrics2.gate_state, "open");
    }
}
