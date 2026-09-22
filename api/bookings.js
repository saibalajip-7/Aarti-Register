import { Redis } from '@upstash/redis';

let redis;
function getRedis(){
  if (!redis) redis = Redis.fromEnv();
  return redis;
}

const LOCATIONS = ['Hostel', 'Ramesh Hall', 'Trayee'];

const DEFAULT_CLASS_OPTIONS = [
  '1BBA','2BBA','3BBA',
  '1B-COM','2B-COM','3B-COM',
  '1ADS','2ADS','3ADS',
  '1FEDA','2FEDA','3FEDA',
  '1BA-ECO','2BA-ECO','3BA-ECO',
  '1MBA','2MBA',
  '1MA','2MA',
  '4 Yr'
];

function dateKey(d){
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Mirrors the default academic-year logic in index.html/register.html:
// rolling 1 Jul -> 31 May window, unless the admin has set a custom range.
function getDefaultAcademicYearRange(){
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth(); // 0 = Jan ... 6 = Jul
  if (m >= 6) return { start: new Date(y, 6, 1), end: new Date(y + 1, 4, 31) };
  return { start: new Date(y - 1, 6, 1), end: new Date(y, 4, 31) };
}

async function getAcademicYearRange(redis){
  const value = await redis.get('academicYearRange');
  if (value && value.start && value.end){
    const start = new Date(value.start + 'T00:00:00');
    const end = new Date(value.end + 'T00:00:00');
    if (!isNaN(start) && !isNaN(end) && start <= end) return { start, end };
  }
  return getDefaultAcademicYearRange();
}

function yearLabelFor(range){
  return range.start.getFullYear() + '-' + range.end.getFullYear();
}

// Same day-of-week rule as the register: Trayee only runs Sunday and Thursday.
function dayAllowedForLocation(location, d){
  if (location === 'Trayee') return d.getDay() === 0 || d.getDay() === 4;
  return true;
}

// A register slot is "occupied" when its name field(s) are filled.
// Trayee Thursdays hold two entries per date; every other slot holds one.
function isSlotOccupied(location, entry){
  if (!entry) return false;
  if (Array.isArray(entry.entries)){
    const [a, b] = entry.entries;
    return !!(a && a.name) && !!(b && b.name);
  }
  return !!entry.name;
}

function newId(){
  return 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

export default async function handler(req, res) {
  const redis = getRedis();

  try {
    if (req.method === 'GET') {
      const action = req.query.action;

      if (action === 'meta') {
        const range = await getAcademicYearRange(redis);
        const yearLabel = yearLabelFor(range);

        const [classOptionsRaw, holidaysRaw, ...registers] = await Promise.all([
          redis.get('classOptions'),
          redis.get('holidays:' + yearLabel),
          ...LOCATIONS.map(loc => redis.get('register:' + yearLabel + ':' + loc))
        ]);

        const classOptions = (Array.isArray(classOptionsRaw) && classOptionsRaw.length) ? classOptionsRaw : DEFAULT_CLASS_OPTIONS;
        const holidayDates = (holidaysRaw && typeof holidaysRaw === 'object') ? Object.keys(holidaysRaw) : [];

        const availability = {};
        LOCATIONS.forEach((loc, i) => {
          const data = (registers[i] && typeof registers[i] === 'object') ? registers[i] : {};
          const occupied = [];
          Object.keys(data).forEach(key => {
            if (isSlotOccupied(loc, data[key])) occupied.push(key);
          });
          availability[loc] = occupied;
        });

        return res.status(200).json({
          yearLabel,
          rangeStart: dateKey(range.start),
          rangeEnd: dateKey(range.end),
          locations: LOCATIONS,
          classOptions,
          holidayDates,
          availability
        });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { name, class: className, phone, location, date, yearLabel } = body || {};

      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Please enter a name.' });
      if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'Please enter a phone number.' });
      if (!LOCATIONS.includes(location)) return res.status(400).json({ error: 'Please choose a valid location.' });
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Please choose a valid date.' });

      const range = await getAcademicYearRange(redis);
      const expectedYearLabel = yearLabelFor(range);
      if (yearLabel && yearLabel !== expectedYearLabel) {
        return res.status(409).json({ error: 'The booking calendar has changed, please reload and try again.' });
      }

      const d = new Date(date + 'T00:00:00');
      if (isNaN(d) || d < range.start || d > range.end) {
        return res.status(400).json({ error: 'That date is outside the current booking period.' });
      }
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (d < today) {
        return res.status(400).json({ error: 'That date has already passed.' });
      }
      if (!dayAllowedForLocation(location, d)) {
        return res.status(400).json({ error: location + ' only accepts visits on Sundays and Thursdays.' });
      }

      const holidays = await redis.get('holidays:' + expectedYearLabel);
      if (holidays && typeof holidays === 'object' && holidays[date]) {
        return res.status(409).json({ error: 'That date is not available.' });
      }

      const registerData = await redis.get('register:' + expectedYearLabel + ':' + location);
      if (isSlotOccupied(location, registerData && registerData[date])) {
        return res.status(409).json({ error: 'Slot already booked. Please choose a different date.' });
      }

      const bookingsKey = 'bookings:' + expectedYearLabel + ':' + location;
      const bookings = (await redis.get(bookingsKey)) || {};
      const id = newId();
      bookings[id] = {
        id,
        name: String(name).trim(),
        class: className ? String(className).trim() : '',
        phone: String(phone).trim(),
        date,
        location,
        status: 'pending',
        createdAt: Date.now()
      };
      await redis.set(bookingsKey, bookings);

      return res.status(200).json({ success: true, id });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
}
