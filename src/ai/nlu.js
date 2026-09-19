// Rule-based NLU for the prototype. This module is the deliberate seam where a real
// LLM (e.g. Claude via the Messages API with tool-use) would replace pattern matching
// with genuine language understanding - the rest of the architecture (context manager,
// capability registry, verification, workflows) does not change. See docs/AI.md.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function nextDateForWeekday(weekday, from = new Date()) {
  const target = WEEKDAYS.indexOf(weekday.toLowerCase());
  if (target === -1) return null;
  const d = new Date(from);
  const diff = (target - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

export function parseTimeframe(text) {
  const lower = text.toLowerCase();
  const now = new Date();
  if (lower.includes('today')) {
    return { fromISO: now.toISOString(), toISO: endOfDay(now).toISOString(), label: 'today' };
  }
  if (lower.includes('tomorrow')) {
    const d = addDays(now, 1);
    return { fromISO: startOfDay(d).toISOString(), toISO: endOfDay(d).toISOString(), label: 'tomorrow' };
  }
  if (lower.includes('this week')) {
    return { fromISO: now.toISOString(), toISO: endOfDay(addDays(now, 7)).toISOString(), label: 'this week' };
  }
  if (lower.includes('next week')) {
    const start = addDays(now, 7);
    return { fromISO: startOfDay(start).toISOString(), toISO: endOfDay(addDays(start, 7)).toISOString(), label: 'next week' };
  }
  for (const wd of WEEKDAYS) {
    if (lower.includes(wd)) {
      const d = nextDateForWeekday(wd, now);
      return { fromISO: startOfDay(d).toISOString(), toISO: endOfDay(d).toISOString(), label: wd };
    }
  }
  return null;
}

function addDays(d, n) { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return c; }
function startOfDay(d) { const c = new Date(d); c.setUTCHours(0, 0, 0, 0); return c; }
function endOfDay(d) { const c = new Date(d); c.setUTCHours(23, 59, 59, 999); return c; }

// Extracts a chosen option from a list, e.g. "the first one", "option 2", "the 3pm slot".
export function parseChoice(text, optionsCount) {
  const lower = text.toLowerCase();
  const ordinalWords = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
  for (const [word, num] of Object.entries(ordinalWords)) {
    if (lower.includes(word) && num <= optionsCount) return num - 1;
  }
  const numMatch = lower.match(/\b(\d+)(st|nd|rd|th)?\b/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (n >= 1 && n <= optionsCount) return n - 1;
  }
  return null;
}

export function isAffirmative(text) {
  return /\b(yes|yeah|yep|confirm|sounds good|that works|correct|sure|ok|okay)\b/i.test(text);
}
export function isNegative(text) {
  return /\b(no|nope|cancel|not that|different)\b/i.test(text);
}

// Detects that the patient is referring back to something already in context
// ("make that Friday", "change it", "that one instead").
export function isReferringToContext(text) {
  return /\b(that|it|instead|actually)\b/i.test(text);
}

export function detectIntent(text, hasActiveAppointmentContext) {
  const lower = text.toLowerCase();
  if (/\b(reschedule|move|change).*(appointment|that|it)\b/.test(lower) || (hasActiveAppointmentContext && /\b(actually|instead)\b/.test(lower) && parseTimeframe(lower))) {
    return 'reschedule_appointment';
  }
  if (/\b(cancel)\b/.test(lower)) return 'cancel_appointment';
  if (/\b(book|schedule|see a doctor|appointment|need to see)\b/.test(lower)) return 'book_appointment';
  if (/\b(status|when is my|do i have an appointment|my appointment)\b/.test(lower)) return 'check_status';
  if (/\b(hi|hello|hey)\b/.test(lower) && lower.length < 20) return 'greeting';
  if (/\b(human|agent|representative|speak to someone)\b/.test(lower)) return 'human_escalation';
  return 'unknown';
}
