export const ROLES = ["player", "owner", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const LANGS = ["en", "hi"] as const;
export type Lang = (typeof LANGS)[number];

/** Sports a venue resource can offer. Labels are translated in the web app (key = id). */
export const SPORTS = [
  "football",
  "box_cricket",
  "cricket_nets",
  "badminton",
  "pickleball",
  "tennis",
  "table_tennis",
  "basketball",
  "volleyball",
  "swimming",
  "snooker",
  "skating",
] as const;
export type Sport = (typeof SPORTS)[number];

export const AMENITIES = [
  "parking",
  "drinking_water",
  "washroom",
  "changing_room",
  "floodlights",
  "seating",
  "first_aid",
  "equipment_rental",
  "cafe",
  "wifi",
  "cctv",
  "shower",
] as const;
export type Amenity = (typeof AMENITIES)[number];

/** Cities seeded at launch. Bareilly first. */
export const SEED_CITIES = [
  { name: "Bareilly", slug: "bareilly", state: "Uttar Pradesh" },
] as const;
