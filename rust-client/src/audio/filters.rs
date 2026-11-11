//! High-pass rumble filter, hysteresis noise gate, and peak limiter

use biquad::{Biquad, Coefficients, DirectForm2Transposed, Hertz, ToHertz, Type, Q_BUTTERWORTH_F32};

/// 80 Hz 2nd-order Butterworth High-Pass Filter
pub struct HighPassFilter {
    filter: DirectForm2Transposed<f32>,
    enabled: bool,
}

impl HighPassFilter {
    pub fn new(sample_rate: u32, cutoff_hz: f32) -> Self {
        let fs: Hertz<f32> = (sample_rate as f32).hz();
        let fc: Hertz<f32> = cutoff_hz.hz();
        let coeffs = Coefficients::<f32>::from_params(Type::HighPass, fs, fc, Q_BUTTERWORTH_F32)
            .unwrap_or_else(|_| {
                Coefficients::<f32>::from_params(
                    Type::HighPass,
                    48000.0.hz(),
                    80.0.hz(),
                    Q_BUTTERWORTH_F32,
                )
                .unwrap()
            });
        Self {
            filter: DirectForm2Transposed::<f32>::new(coeffs),
            enabled: true,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    #[inline]
    pub fn process_sample(&mut self, sample: f32) -> f32 {
        if self.enabled {
            self.filter.run(sample)
        } else {
            sample
        }
    }

    pub fn process_buffer(&mut self, buffer: &mut [f32]) {
        if !self.enabled {
            return;
        }
        for s in buffer.iter_mut() {
            *s = self.filter.run(*s);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateState {
    Closed,
    Holding,
    Open,
}

/// Hysteresis Noise Gate with smooth attack, hold, and release
pub struct HysteresisGate {
    open_threshold_linear: f32,
    close_threshold_linear: f32,
    attack_coeff: f32,
    release_coeff: f32,
    hold_samples: usize,
    hold_counter: usize,
    current_gain: f32,
    state: GateState,
    enabled: bool,
}

impl HysteresisGate {
    pub fn new(
        sample_rate: u32,
        open_threshold_db: f32,
        close_threshold_db: f32,
        attack_ms: f32,
        hold_ms: f32,
        release_ms: f32,
    ) -> Self {
        let open_linear = 10.0f32.powf(open_threshold_db / 20.0);
        let close_linear = 10.0f32.powf(close_threshold_db / 20.0);

        let attack_samples = (attack_ms * (sample_rate as f32) / 1000.0).max(1.0);
        let release_samples = (release_ms * (sample_rate as f32) / 1000.0).max(1.0);

        Self {
            open_threshold_linear: open_linear,
            close_threshold_linear: close_linear,
            attack_coeff: 1.0 / attack_samples,
            release_coeff: 1.0 / release_samples,
            hold_samples: (hold_ms * (sample_rate as f32) / 1000.0) as usize,
            hold_counter: 0,
            current_gain: 0.0,
            state: GateState::Closed,
            enabled: true,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn state(&self) -> GateState {
        self.state
    }

    pub fn current_gain(&self) -> f32 {
        self.current_gain
    }

    /// Process a frame of samples (e.g. 480 samples @ 48 kHz = 10 ms)
    pub fn process_frame(&mut self, buffer: &mut [f32]) {
        if !self.enabled || buffer.is_empty() {
            return;
        }

        let mut sum_sq = 0.0f32;
        for &s in buffer.iter() {
            sum_sq += s * s;
        }
        let rms = (sum_sq / (buffer.len() as f32)).sqrt();

        if rms >= self.open_threshold_linear {
            self.state = GateState::Open;
            self.hold_counter = self.hold_samples;
        } else if self.state == GateState::Open || self.state == GateState::Holding {
            if rms < self.close_threshold_linear {
                if self.hold_counter > buffer.len() {
                    self.hold_counter -= buffer.len();
                    self.state = GateState::Holding;
                } else {
                    self.hold_counter = 0;
                    self.state = GateState::Closed;
                }
            } else {
                self.hold_counter = self.hold_samples;
                self.state = GateState::Open;
            }
        }

        let target_gain = if self.state != GateState::Closed { 1.0 } else { 0.0 };

        for s in buffer.iter_mut() {
            if self.current_gain < target_gain {
                self.current_gain = (self.current_gain + self.attack_coeff).min(target_gain);
            } else if self.current_gain > target_gain {
                self.current_gain = (self.current_gain - self.release_coeff).max(target_gain);
            }
            *s *= self.current_gain;
        }
    }
}

/// Peak Limiter / Soft Clipper preventing digital clipping above -0.5 dBFS
pub struct PeakLimiter {
    threshold: f32,
}

impl PeakLimiter {
    pub fn new(threshold_db: f32) -> Self {
        Self {
            threshold: 10.0f32.powf(threshold_db / 20.0),
        }
    }

    #[inline]
    pub fn process_sample(&self, sample: f32) -> f32 {
        if sample.abs() <= self.threshold {
            sample
        } else if sample > 0.0 {
            let excess = sample - self.threshold;
            self.threshold + (1.0 - self.threshold) * excess.tanh()
        } else {
            let excess = -sample - self.threshold;
            -(self.threshold + (1.0 - self.threshold) * excess.tanh())
        }
    }

    pub fn process_buffer(&self, buffer: &mut [f32]) {
        for s in buffer.iter_mut() {
            *s = self.process_sample(*s);
        }
    }
}
