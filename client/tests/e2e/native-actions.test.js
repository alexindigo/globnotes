import { afterEach, expect, it } from "vitest";
import { editableControl } from "./native-actions.mjs";

afterEach(() => { document.body.innerHTML = ""; });

it("does not admit a retained readonly value ID before its native control loads", () => {
  document.body.innerHTML = '<div tabindex="-1"><span id="settings-field-retention">2</span></div>';
  const value = document.querySelector("#settings-field-retention");
  expect(!value.disabled).toBe(true); // The old case admitted this loading value.
  expect(editableControl(value)).toBe(false);
  value.replaceWith(Object.assign(document.createElement("input"), { id: value.id, type: "range", min: "1", max: "10", value: "2" }));
  const control = document.querySelector("#settings-field-retention");
  expect(editableControl(control)).toBe(true);
  expect(value.isConnected).toBe(false);
  expect(editableControl(value)).toBe(false);
});

it("admits only connected editable native controls, including ancestor restrictions", () => {
  for (const html of [
    '<input type="range">', '<input type="text">', '<textarea></textarea>', '<select><option>One</option></select>',
  ]) {
    document.body.innerHTML = html;
    expect(editableControl(document.body.firstElementChild)).toBe(true);
  }
  for (const html of [
    '<input disabled>', '<input readonly>', '<input type="hidden">', '<textarea readonly></textarea>', '<select disabled></select>',
    '<fieldset disabled><input></fieldset>', '<div inert><input></div>', '<span>Value</span>',
  ]) {
    document.body.innerHTML = html;
    expect(editableControl(document.body.querySelector('input,textarea,select,span'))).toBe(false);
  }
  expect(editableControl(document.createElement("input"))).toBe(false);
  expect(editableControl(null)).toBe(false);
});
