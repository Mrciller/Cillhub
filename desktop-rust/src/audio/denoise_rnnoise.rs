//! Pure-Rust SIMD RNNoise neural network denoiser using nnnoiseless

use nnnoiseless::DenoiseState;

pub const RNNOISE_FRAME_SIZE: usize = DenoiseState::FRAME_SIZE; // 480 samples @ 48 kHz = 10 ms

pub struct RnnoiseDenoiser {
    state: Box<DenoiseState<'static>>,
    enabled: bool,
    temp_in: [f32; RNNOISE_FRAME_SIZE],
    temp_out: [f32; RNNOISE_FRAME_SIZE],
}

impl RnnoiseDenoiser {
    pub fn new() -> Self {
        Self {
            state: DenoiseState::new(),
            enabled: true,
            temp_in: [0.0; RNNOISE_FRAME_SIZE],
            temp_out: [0.0; RNNOISE_FRAME_SIZE],
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// Process a 480-sample (10 ms) frame in-place
    pub fn process_frame(&mut self, frame: &mut [f32]) {
        if !self.enabled || frame.len() != RNNOISE_FRAME_SIZE {
            return;
        }

        // RNNoise expects samples scaled by 32767.0
        for (i, &s) in frame.iter().enumerate() {
            self.temp_in[i] = s * 32767.0;
        }

        self.state.process_frame(&mut self.temp_out, &self.temp_in);

        // Convert back to -1.0 .. 1.0 range
        for (i, s) in frame.iter_mut().enumerate() {
            *s = self.temp_out[i] / 32767.0;
        }
    }
}
