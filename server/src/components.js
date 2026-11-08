// Message components and modals (components v1: action rows, buttons, selects, text inputs), per developers/components
import { invalid } from './errors.js';

export const C = { ACTION_ROW: 1, BUTTON: 2, STRING_SELECT: 3, TEXT_INPUT: 4, USER_SELECT: 5, ROLE_SELECT: 6, MENTIONABLE_SELECT: 7, CHANNEL_SELECT: 8 };
const SELECTS = [3, 5, 6, 7, 8];
const fail = (path, msg) => { throw invalid(path, 'COMPONENT_INVALID', msg); };
const text = (v, path, min, max, required = true) => {
  if (v == null && !required) return undefined;
  if (typeof v !== 'string' || v.length < min || v.length > max) fail(path, `Must be a string of ${min} to ${max} characters.`);
  return v;
};
const optInt = (v, path, min, max) => (v == null ? undefined : Number.isInteger(v) && v >= min && v <= max ? v : fail(path, `Must be an integer between ${min} and ${max}.`));
const emoji = (e, path) => (e == null ? undefined : { ...(e.id != null && { id: String(e.id) }), name: text(e.name ?? '', `${path}.name`, 0, 32), ...(e.animated && { animated: true }) });
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function button(c, path, ids) {
  const style = optInt(c.style, `${path}.style`, 1, 6) ?? fail(`${path}.style`, 'Required.');
  if (style === 6) fail(`${path}.style`, 'Premium buttons are not supported.');
  const out = { type: 2, style, label: text(c.label, `${path}.label`, 0, 80, false), emoji: emoji(c.emoji, `${path}.emoji`), disabled: c.disabled ? true : undefined };
  if (style === 5) {
    if (typeof c.url !== 'string' || c.url.length > 512 || !/^(https?|cillhub|cillcord):\/\//i.test(c.url)) fail(`${path}.url`, 'Link buttons need an http(s) url.');
    out.url = c.url;
  } else out.custom_id = text(c.custom_id, `${path}.custom_id`, 1, 100);
  if (out.label === undefined && out.emoji === undefined) fail(path, 'A button needs a label or an emoji.');
  ids.push(out.custom_id);
  return clean(out);
}

function select(c, path, ids) {
  const out = {
    type: c.type, custom_id: text(c.custom_id, `${path}.custom_id`, 1, 100), placeholder: text(c.placeholder, `${path}.placeholder`, 0, 150, false),
    min_values: optInt(c.min_values, `${path}.min_values`, 0, 25), max_values: optInt(c.max_values, `${path}.max_values`, 1, 25),
    disabled: c.disabled ? true : undefined,
  };
  ids.push(out.custom_id);
  if (c.type === 3) {
    if (!Array.isArray(c.options) || !c.options.length || c.options.length > 25) fail(`${path}.options`, 'Between 1 and 25 options.');
    out.options = c.options.map((o, i) => clean({
      label: text(o?.label, `${path}.options.${i}.label`, 1, 100), value: text(o?.value, `${path}.options.${i}.value`, 1, 100),
      description: text(o?.description, `${path}.options.${i}.description`, 0, 100, false), emoji: emoji(o?.emoji, `${path}.options.${i}.emoji`),
      default: o?.default ? true : undefined,
    }));
  }
  if (c.type === 8 && c.channel_types != null) out.channel_types = Array.isArray(c.channel_types) ? c.channel_types.filter(Number.isInteger) : fail(`${path}.channel_types`, 'Must be a list.');
  if ([5, 6, 7, 8].includes(c.type) && Array.isArray(c.default_values)) {
    out.default_values = c.default_values.slice(0, 25).map(d => ({ id: String(d?.id), type: ['user', 'role', 'channel'].includes(d?.type) ? d.type : fail(`${path}.default_values`, 'Bad type.') }));
  }
  if ((out.max_values ?? 1) < (out.min_values ?? 1)) fail(path, 'max_values must be at least min_values.');
  return clean(out);
}

export function textInput(c, path) {
  const out = {
    type: 4, custom_id: text(c?.custom_id, `${path}.custom_id`, 1, 100), style: optInt(c?.style, `${path}.style`, 1, 2) ?? fail(`${path}.style`, 'Required.'),
    label: text(c?.label, `${path}.label`, 1, 45, false), min_length: optInt(c?.min_length, `${path}.min_length`, 0, 4000),
    max_length: optInt(c?.max_length, `${path}.max_length`, 1, 4000), required: c?.required === false ? false : undefined,
    value: text(c?.value, `${path}.value`, 0, 4000, false), placeholder: text(c?.placeholder, `${path}.placeholder`, 0, 100, false),
  };
  return clean(out);
}

// message components: up to 5 action rows with up to 5 buttons or exactly one select; custom_ids unique
export function messageComponents(list, path = 'components') {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 5) fail(path, 'At most 5 action rows.');
  const ids = [];
  const rows = list.map((row, r) => {
    if (row?.type !== 1 || !Array.isArray(row.components) || !row.components.length) fail(`${path}.${r}`, 'Must be an action row with components.');
    const comps = row.components.map((c, i) => {
      const p = `${path}.${r}.components.${i}`;
      if (c?.type === 2) return button(c, p, ids);
      if (SELECTS.includes(c?.type)) return select(c, p, ids);
      return fail(p, 'Unsupported component type.');
    });
    if (comps.some(c => c.type !== 2) && comps.length !== 1) fail(`${path}.${r}`, 'A select fills its action row.');
    if (comps.length > 5) fail(`${path}.${r}`, 'At most 5 buttons per row.');
    return { type: 1, components: comps };
  });
  const custom = ids.filter(Boolean);
  if (new Set(custom).size !== custom.length) fail(path, 'custom_id values must be unique.');
  return rows;
}

// modal: custom_id, title, 1-5 action rows each holding one text input (labels with a text input are accepted too)
export function modal(d) {
  const custom_id = text(d?.custom_id, 'data.custom_id', 1, 100);
  const title = text(d?.title, 'data.title', 1, 45);
  if (!Array.isArray(d.components) || !d.components.length || d.components.length > 5) fail('data.components', 'Between 1 and 5 rows.');
  const components = d.components.map((row, r) => {
    if (row?.type === 18 && row.component?.type === 4) return { type: 1, components: [textInput({ ...row.component, label: row.label }, `data.components.${r}.component`)] };
    if (row?.type !== 1 || row.components?.length !== 1 || row.components[0]?.type !== 4) fail(`data.components.${r}`, 'Each row holds one text input.');
    return { type: 1, components: [textInput(row.components[0], `data.components.${r}.components.0`)] };
  });
  return { custom_id, title, components };
}

export const findComponent = (rows, customId) => rows.flatMap(r => r.components ?? []).find(c => c.custom_id === customId);
export const isSelect = type => SELECTS.includes(type);
