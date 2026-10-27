import assert from "node:assert/strict";
import { test } from "node:test";
import { checkClick, seesCaptcha } from "./guard.ts";

const at = "https://www.opentable.com/r/demo-bistro";
const click = (role: string, name: string, url = at) => checkClick({ role, name, url });

test("stops on commit buttons", () => {
  for (const name of ["Book now", "Complete reservation", "Confirm booking", "Reserve", "Pay $42.00", "Place order", "Proceed to checkout", "Submit", "Send"]) {
    assert.equal(click("button", name).stop, true, name);
  }
});

test("lets ordinary navigation through", () => {
  for (const name of ["Bookmarks", "Facebook", "PayPal help", "8:00 PM", "2 people", "See menu", "Booking details", "Reserved tables", "Confirmed"]) {
    assert.equal(click("button", name).stop, false, name);
  }
});

test("only clickable roles count", () => {
  assert.equal(click("heading", "Confirm your reservation").stop, false);
  assert.equal(click("link", "Book a table").stop, true);
});

test("any button on a checkout page stops", () => {
  const verdict = click("button", "Continue", "https://shop.example.com/checkout/");
  assert.equal(verdict.stop, true);
  assert.equal(click("link", "Back to cart", "https://shop.example.com/checkout").stop, false);
  assert.equal(click("button", "Continue", "not a url").stop, false);
});

test("the reason names what it saw", () => {
  const verdict = click("button", "Complete reservation");
  assert.ok(verdict.stop && verdict.reason.includes("Complete reservation"));
});

test("spots CAPTCHAs by frame or wording", () => {
  assert.equal(seesCaptcha({ frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=x"], text: "" }), true);
  assert.equal(seesCaptcha({ frameUrls: ["https://challenges.cloudflare.com/turnstile/v0"], text: "" }), true);
  assert.equal(seesCaptcha({ frameUrls: [], text: "Please verify you are human" }), true);
  assert.equal(seesCaptcha({ frameUrls: ["https://maps.example.com/embed"], text: "Table for two at 8:00 PM" }), false);
});
