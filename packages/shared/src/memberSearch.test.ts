import { describe, expect, it } from "vitest";
import { filterMembers } from "./memberSearch";

const m = (uid: string, name: string, email: string) => ({ uid, name, email });
const people = [
  m("1", "Sam Rao", "sam.rao@gmail.com"),
  m("2", "Sam Rao", "samrao@work.org"),
  m("3", "Zoë Müller", "zoe@example.com"),
  m("4", "Priya Nair", "samantha@example.com"),
  m("5", "Amrit Dash", "amrit@contoureducation.com.au"),
];
const ids = (r: { uid: string }[]) => r.map((x) => x.uid);

describe("filterMembers", () => {
  it("lists everyone for a blank query", () => expect(filterMembers(people, "  ")).toHaveLength(5));
  it("matches name word starts and keeps same-name people apart", () => {
    expect(ids(filterMembers(people, "rao"))).toEqual(["1", "2"]);
    expect(ids(filterMembers(people, "sam r"))).toEqual(["1", "2"]);
  });
  it("ignores case and accents", () => {
    expect(ids(filterMembers(people, "ZOE"))).toEqual(["3"]);
    expect(ids(filterMembers(people, "muller"))).toEqual(["3"]);
    expect(ids(filterMembers(people, "Zoë"))).toEqual(["3"]);
  });
  it("matches by email, but only at word starts", () => {
    expect(ids(filterMembers(people, "samantha"))).toEqual(["4"]);
    expect(ids(filterMembers(people, "contour"))).toEqual(["5"]);
    expect(ids(filterMembers(people, "amrit@"))).toEqual(["5"]);
    expect(filterMembers(people, "ao")).toEqual([]);
  });
  it("ranks name matches before email-only ones", () => expect(ids(filterMembers(people, "sam"))).toEqual(["1", "2", "4"]));
  it("excludes chosen uids", () => expect(ids(filterMembers(people, "sam", ["1"]))).toEqual(["2", "4"]));
  it("returns nothing when nothing matches", () => expect(filterMembers(people, "qqq")).toEqual([]));
});
