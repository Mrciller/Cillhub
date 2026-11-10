// Due-time work (thread auto-archive, poll finalize, event status, retention) is read from the database each time
// the timer fires, so nothing is lost across restarts: a job only says when it is next due and does what is due now.
const jobs = []; // { name, next(): unix ms | null, run(now) }
const MAX_WAIT = 60 * 60 * 1000; // sweep at least hourly for the retention jobs
let handle = null;

export const addJob = job => jobs.push(job);

function fire() {
  handle = null;
  const now = Date.now();
  for (const j of jobs) {
    if (j.busy) continue; // an async run from the last firing is still going
    try {
      const r = j.run(now);
      if (r?.then) (j.busy = true, r.catch(e => console.error(`timer ${j.name} failed:`, e)).finally(() => { j.busy = false; }));
    } catch (e) { console.error(`timer ${j.name} failed:`, e); }
  }
  schedule();
}

// re-arm for the earliest due job; call after anything that may have made a job due sooner
export function schedule() {
  const now = Date.now();
  let next = now + MAX_WAIT;
  for (const j of jobs) {
    try { next = Math.min(next, j.next() ?? Infinity); } catch (e) { console.error(`timer ${j.name} failed:`, e); }
  }
  clearTimeout(handle);
  handle = setTimeout(fire, Math.max(0, next - now));
}

export const startTimers = fire;
export const stopTimers = () => { clearTimeout(handle); handle = null; };
