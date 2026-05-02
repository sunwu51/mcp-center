function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function formatTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + ' ' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(':') + '.' + pad(date.getMilliseconds(), 3);
}

function withTimestamp(args) {
  const prefix = `[${formatTimestamp()}]`;
  if (args.length === 0) {
    return [prefix];
  }

  const [first, ...rest] = args;
  if (typeof first === 'string') {
    return [`${prefix} ${first}`, ...rest];
  }
  return [prefix, first, ...rest];
}

export function log(...args) {
  console.log(...withTimestamp(args));
}

export function warn(...args) {
  console.warn(...withTimestamp(args));
}

export function error(...args) {
  console.error(...withTimestamp(args));
}
