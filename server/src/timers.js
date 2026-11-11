// Due-time work (thread auto-archive, poll finalize, event status, retention) is read from the database each time
// the timer fires, so nothing is lost across restarts: a job only says when it is next due and does what is due now.
const jobs = []; // { name, next(): unix ms | null, run(now) }
const MAX_WAIT = 60 * 60 * 1000; // sweep at least hourly for the retention jobs
let handle = null;
const RETRY = 5000; // a job that failed waits this long before it runs again (its deadline may still be overdue)
const failed = (j, e) => { j.failedAt = Date.now(); console.error(`timer ${j.name} failed:`, e); };

export const addJob = job => jobs.push(job);

function fire() {
  handle = null;
  const now = Date.now();
  for (const j of jobs) {
    if (j.busy || now - (j.failedAt ?? 0) < RETRY) continue; // an async run is still going, or it failed just now
    try {
      const r = j.run(now);
      if (r?.then) (j.busy = true, r.catch(e => failed(j, e)).finally(() => { j.busy = false; if (handle) schedule(); }));
    } catch (e) { failed(j, e); }
  }
  schedule();
}

// re-arm for the earliest due job; call after anything that may have made a job due sooner
export function schedule() {
  const now = Date.now();
  let next = now + MAX_WAIT;
  for (const j of jobs) {
    if (j.busy) continue; // re-armed when it settles; its overdue deadline would fire the timer again and again
    try { next = Math.min(next, Math.max(j.next() ?? Infinity, (j.failedAt ?? 0) + RETRY)); } catch (e) { console.error(`timer ${j.name} failed:`, e); }
  }
  clearTimeout(handle);
  handle = setTimeout(fire, Math.max(0, next - now));
}

export const startTimers = fire;
export const stopTimers = () => { clearTimeout(handle); handle = null; };
