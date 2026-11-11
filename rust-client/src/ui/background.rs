//! Network work off the egui thread: jobs run on worker threads, their results come back over a channel and
//! are applied in the next frame. Writes go through one ordered worker (two sends keep their order), reads
//! through a small pool. Results of a session that has ended (logout, new login) are dropped.
use super::CillhubApp;
use crate::api::{ApiClient, ApiError};
use serde_json::Value;
use std::sync::{mpsc, Arc, Mutex};

type UiFn = Box<dyn FnOnce(&mut CillhubApp) + Send>;
type Job = (u64, Box<dyn FnOnce() -> UiFn + Send>);

pub struct Workers {
    ordered: mpsc::Sender<Job>,
    pool: mpsc::Sender<Job>,
    done: mpsc::Receiver<(u64, UiFn)>,
    pub pending: usize,
}

impl Workers {
    pub fn new() -> Self {
        let (done_tx, done) = mpsc::channel();
        let start = |threads: usize| {
            let (tx, rx) = mpsc::channel::<Job>();
            let rx = Arc::new(Mutex::new(rx));
            for _ in 0..threads {
                let (rx, done_tx) = (rx.clone(), done_tx.clone());
                std::thread::spawn(move || loop {
                    let Ok(Ok((generation, job))) = rx.lock().map(|r| r.recv()) else { return };
                    if done_tx.send((generation, job())).is_err() {
                        return; // the app has closed
                    }
                });
            }
            tx
        };
        Self { ordered: start(1), pool: start(4), done, pending: 0 }
    }
}

impl CillhubApp {
    /// Runs `job` on a worker; `done` gets its result on the UI thread (unless the session ended meanwhile).
    pub fn spawn_bg<R: Send + 'static>(
        &mut self,
        ordered: bool,
        job: impl FnOnce() -> R + Send + 'static,
        done: impl FnOnce(&mut CillhubApp, R) + Send + 'static,
    ) {
        let job = Box::new(move || {
            let r = job();
            Box::new(move |app: &mut CillhubApp| done(app, r)) as UiFn
        });
        let queue = if ordered { &self.bg.ordered } else { &self.bg.pool };
        if queue.send((self.session_gen, job)).is_ok() {
            self.bg.pending += 1;
        }
    }

    /// A request with the session's API client: reads in the pool, writes (`ordered`) in order.
    /// False without a server (demo mode), and then nothing is sent.
    pub fn api_bg(
        &mut self,
        ordered: bool,
        req: impl FnOnce(&ApiClient) -> Result<Value, ApiError> + Send + 'static,
        done: impl FnOnce(&mut CillhubApp, Result<Value, ApiError>) + Send + 'static,
    ) -> bool {
        let Some(api) = self.api.clone() else { return false };
        self.spawn_bg(ordered, move || req(&api), done);
        true
    }

    pub fn api_get(&mut self, path: String, done: impl FnOnce(&mut CillhubApp, Result<Value, ApiError>) + Send + 'static) -> bool {
        self.api_bg(false, move |api| api.get(&path), done)
    }

    /// Applies finished background work (every frame).
    pub fn pump_bg(&mut self) {
        while let Ok((generation, apply)) = self.bg.done.try_recv() {
            self.bg.pending -= 1;
            if generation == self.session_gen {
                apply(self);
            }
        }
    }

    /// Ends the session for background work: results still in flight are dropped.
    pub fn new_session(&mut self) {
        self.session_gen += 1;
        // their lookups are dropped with the session, and the next one may be another hub
        self.invite_cards.clear();
        self.invite_lookups = 0;
    }
}

impl CillhubApp {
    /// With a server: `req` (in order), then `apply` once it succeeded; a failure is reported and changes
    /// nothing. Without a server (demo mode): `apply` right away.
    pub fn api_then(
        &mut self,
        req: impl FnOnce(&ApiClient) -> Result<Value, ApiError> + Send + 'static,
        apply: impl FnOnce(&mut CillhubApp) + Send + 'static,
    ) {
        if self.api.is_none() {
            return apply(self);
        }
        self.api_bg(true, req, move |app, r| {
            if super::report(&mut app.status_banner, r).is_some() {
                apply(app);
            }
        });
    }
}
