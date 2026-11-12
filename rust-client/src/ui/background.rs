//! Network work off the egui thread: jobs run on worker threads, their results come back over a channel and
//! are applied in the next frame. Writes go through one ordered worker (two sends keep their order), reads
//! through a small pool. Results of a session that has ended (logout, new login) are dropped.
use super::CillhubApp;
use crate::i18n::tr;
use crate::api::{ApiClient, ApiError};
use serde_json::Value;
use std::sync::{mpsc, Arc, Mutex};

type UiFn = Box<dyn FnOnce(&mut CillhubApp) + Send>;

/// Jobs waiting or running at most, for the hub and for private nodes each; more are refused (the caller sees
/// false), so nothing queues without bound and a node's slow or many jobs cannot hold up the hub's.
pub const MAX_JOBS: usize = 1000;
/// Private nodes' jobs at most, queued, running or answered but not yet applied: their answers wait in memory
/// (up to api::NODE_MAX_BODY each) until the next frame, so few are allowed.
pub const NODE_MAX_JOBS: usize = 16;
/// (session, for a node, job)
type Job = (u64, bool, Box<dyn FnOnce() -> UiFn + Send>);

pub struct Workers {
    ordered: mpsc::Sender<Job>,
    pool: mpsc::Sender<Job>,
    node_ordered: mpsc::Sender<Job>,
    node_pool: mpsc::Sender<Job>,
    done: mpsc::Receiver<(u64, bool, UiFn)>,
    /// all jobs, and the private nodes' among them
    pub pending: usize,
    pub node_pending: usize,
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
                    let Ok(Ok((generation, node, job))) = rx.lock().map(|r| r.recv()) else { return };
                    if done_tx.send((generation, node, job())).is_err() {
                        return; // the app has closed
                    }
                });
            }
            tx
        };
        Self { ordered: start(1), pool: start(4), node_ordered: start(1), node_pool: start(2), done, pending: 0, node_pending: 0 }
    }
}

impl CillhubApp {
    /// Runs `job` on a worker; `done` gets its result on the UI thread (unless the session ended meanwhile).
    pub fn spawn_bg<R: Send + 'static>(
        &mut self,
        ordered: bool,
        job: impl FnOnce() -> R + Send + 'static,
        done: impl FnOnce(&mut CillhubApp, R) + Send + 'static,
    ) -> bool {
        self.spawn_in(false, ordered, job, done)
    }

    /// `node`: a private node's job, on its own workers and with its own bound.
    pub(super) fn spawn_in<R: Send + 'static>(
        &mut self,
        node: bool,
        ordered: bool,
        job: impl FnOnce() -> R + Send + 'static,
        done: impl FnOnce(&mut CillhubApp, R) + Send + 'static,
    ) -> bool {
        let hub_pending = self.bg.pending - self.bg.node_pending;
        let full = if node { self.bg.node_pending >= NODE_MAX_JOBS } else { hub_pending >= MAX_JOBS };
        if full {
            eprintln!("cillhub: too much background work queued; refused a job");
            return false;
        }
        let job = Box::new(move || {
            let r = job();
            Box::new(move |app: &mut CillhubApp| done(app, r)) as UiFn
        });
        let queue = match (node, ordered) {
            (false, true) => &self.bg.ordered,
            (false, false) => &self.bg.pool,
            (true, true) => &self.bg.node_ordered,
            (true, false) => &self.bg.node_pool,
        };
        let sent = queue.send((self.session_gen, node, job)).is_ok();
        self.bg.pending += sent as usize;
        self.bg.node_pending += (sent && node) as usize;
        sent
    }

    /// A request with the session's API client: reads in the pool, writes (`ordered`) in order.
    /// False without a server (demo mode), and then nothing is sent.
    pub fn api_bg(
        &mut self,
        ordered: bool,
        req: impl FnOnce(&ApiClient) -> Result<Value, ApiError> + Send + 'static,
        done: impl FnOnce(&mut CillhubApp, Result<Value, ApiError>) + Send + 'static,
    ) -> bool {
        // the connection whose data is in front: its origin and token, and its data again for the answer
        let (conn, gen) = (self.front.clone(), self.front_gen());
        let Some(api) = self.front_api().cloned() else { return false };
        // runs after the session check in pump_bg, so an old session's answer cannot raise the gate
        let node = conn.is_some();
        let sent = self.spawn_in(node, ordered, move || req(&api), move |app, r| {
            if !app.conn_alive(&conn, gen) {
                return; // that node was removed or signed out meanwhile
            }
            if let Err(e) = &r {
                if conn.is_none() && e.accept_terms() && app.terms_gate.is_none() {
                    app.terms_gate = Some(e.message.clone());
                }
            }
            app.with_conn(&conn, |app| {
                // a node's answer is counted against its budget before any of it goes in
                if let Ok(v) = &r {
                    if conn.is_some() && !app.within_budget(super::connections::weight(v)) {
                        return;
                    }
                }
                done(app, r)
            });
        });
        if !sent {
            self.status_banner = Some(tr("Too much is going on right now. Try again in a moment.").to_string());
        }
        sent
    }

    pub fn api_get(&mut self, path: String, done: impl FnOnce(&mut CillhubApp, Result<Value, ApiError>) + Send + 'static) -> bool {
        self.api_bg(false, move |api| api.get(&path), done)
    }

    /// A new request for `key` (a canvas, a search, the history after READY): answers to older ones become stale.
    /// The session check in pump_bg drops other sessions' answers; this drops older answers within one session.
    pub fn new_scope(&mut self, key: &str) -> u64 {
        let g = self.scopes.entry(key.to_string()).or_default();
        *g += 1;
        *g
    }

    /// The current generation of `key`, for requests that share it (all history requests of one READY).
    pub fn scope_now(&mut self, key: &str) -> u64 {
        *self.scopes.entry(key.to_string()).or_default()
    }

    /// Whether `generation` is still the newest request for `key`.
    pub fn in_scope(&self, key: &str, generation: u64) -> bool {
        self.scopes.get(key) == Some(&generation)
    }

    /// Applies finished background work (every frame).
    pub fn pump_bg(&mut self) {
        while let Ok((generation, node, apply)) = self.bg.done.try_recv() {
            self.bg.pending -= 1;
            self.bg.node_pending -= node as usize;
            if generation == self.session_gen {
                apply(self);
            }
        }
    }

    /// Ends the session for background work: results still in flight are dropped.
    pub fn new_session(&mut self) {
        self.session_gen += 1;
        self.session_live.store(self.session_gen, std::sync::atomic::Ordering::SeqCst);
        // their lookups are dropped with the session, and the next one may be another hub
        self.invite_cards.clear();
        self.invite_lookups = 0;
        self.terms_gate = None; // it belongs to the session's server
        self.poll_pending.clear(); // votes chosen by the previous account
        // node checks in flight are dropped too: run them again
        self.node_status = None;
        self.node_busy = false;
        if let Some(p) = &mut self.pending_add_node {
            if p.check == Some(crate::nodes::NodeCheck::Checking) {
                p.check = None;
            }
        }
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
