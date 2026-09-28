import {
  minPricePaise,
  type CreateBusiness,
  type CreateResource,
  type CreateVenue,
  type UpdateBusiness,
  type UpdateResource,
  type UpdateVenue,
} from "@townplay/shared";
import { Types } from "mongoose";
import { HttpError, notFound } from "../lib/httpError.js";
import type { AuthUser } from "../middleware/auth.js";
import { BusinessModel, type BusinessDoc } from "../models/business.js";
import { CityModel } from "../models/city.js";
import { ResourceModel } from "../models/resource.js";
import { UserModel } from "../models/user.js";
import { VenueModel, type VenueDoc } from "../models/venue.js";
import { audit } from "./audit.js";
import { isOwnPhotoUrl, type CloudinaryConfig } from "./uploads.js";

const isAdmin = (user: AuthUser) => user.roles.includes("admin");
const oid = (id: string) => new Types.ObjectId(id);

/** Owners may only touch their own business; admins may touch any. Others get 404. */
export async function loadOwnedBusiness(user: AuthUser, id: string): Promise<BusinessDoc> {
  const business = await BusinessModel.findById(id);
  if (!business) throw notFound("Business");
  if (!isAdmin(user) && !business.ownerUserIds.some((o) => o.equals(user.id))) {
    throw notFound("Business");
  }
  return business;
}

export async function loadOwnedVenue(
  user: AuthUser,
  id: string,
): Promise<{ venue: VenueDoc; business: BusinessDoc }> {
  const venue = await VenueModel.findById(id);
  if (!venue) throw notFound("Venue");
  try {
    const business = await loadOwnedBusiness(user, String(venue.businessId));
    return { venue, business };
  } catch {
    throw notFound("Venue");
  }
}

// ---------- businesses ----------

export async function createBusiness(user: AuthUser, input: CreateBusiness) {
  const business = await BusinessModel.create({
    ...input,
    ownerUserIds: [oid(user.id)],
    status: "draft",
  });
  await UserModel.updateOne({ _id: oid(user.id) }, { $addToSet: { roles: "owner" } });
  await audit(user.id, "business.create", "business", String(business._id));
  return business;
}

export async function updateBusiness(user: AuthUser, id: string, input: UpdateBusiness) {
  const business = await loadOwnedBusiness(user, id);
  business.set(input);
  await business.save();
  await audit(user.id, "business.update", "business", id, { fields: Object.keys(input) });
  return business;
}

export function listMyBusinesses(user: AuthUser) {
  return BusinessModel.find({ ownerUserIds: oid(user.id) }).sort({ createdAt: 1 });
}

// ---------- venues ----------

async function uniqueSlug(cityId: Types.ObjectId, name: string, exceptId?: Types.ObjectId) {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "venue";
  const taken = new Set(
    (
      await VenueModel.find(
        {
          cityId,
          slug: { $regex: `^${base}(-\\d+)?$` },
          ...(exceptId ? { _id: { $ne: exceptId } } : {}),
        },
        { slug: 1 },
      ).lean()
    ).map((v) => v.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function checkPhotos(
  cloudinary: CloudinaryConfig | undefined,
  photos: { url: string }[] | undefined,
) {
  const bad = photos?.find((p) => !isOwnPhotoUrl(cloudinary, p.url));
  if (bad) {
    throw new HttpError(400, "VALIDATION_FAILED", "Photos must be uploaded through Townplay", {
      url: bad.url,
    });
  }
}

export async function createVenue(
  user: AuthUser,
  input: CreateVenue,
  cloudinary: CloudinaryConfig | undefined,
) {
  const business = await loadOwnedBusiness(user, input.businessId);
  const city = await CityModel.findOne({ slug: input.citySlug, isActive: true });
  if (!city)
    throw new HttpError(400, "VALIDATION_FAILED", "Unknown city", { citySlug: input.citySlug });
  checkPhotos(cloudinary, input.photos);

  const { businessId: _b, citySlug: _c, location, ...fields } = input;
  // Two owners naming venues alike at the same moment can race on the slug; retry once.
  for (let attempt = 0; ; attempt++) {
    try {
      const venue = await VenueModel.create({
        ...fields,
        businessId: business._id,
        cityId: city._id,
        citySlug: city.slug,
        slug: await uniqueSlug(city._id, input.name),
        geo: { type: "Point", coordinates: [location.lng, location.lat] },
        status: "draft",
        businessActive: business.status === "active",
      });
      await audit(user.id, "venue.create", "venue", String(venue._id));
      return venue;
    } catch (err) {
      if (attempt === 0 && typeof err === "object" && err && "code" in err && err.code === 11000)
        continue;
      throw err;
    }
  }
}

export async function updateVenue(
  user: AuthUser,
  id: string,
  input: UpdateVenue,
  cloudinary: CloudinaryConfig | undefined,
) {
  const { venue } = await loadOwnedVenue(user, id);
  checkPhotos(cloudinary, input.photos);
  const { location, ...fields } = input;
  venue.set(fields);
  if (location) venue.set("geo", { type: "Point", coordinates: [location.lng, location.lat] });
  // The slug is kept while the venue is live so shared links keep working.
  if (input.name && venue.status !== "live") {
    venue.slug = await uniqueSlug(venue.cityId, input.name, venue._id);
  }
  // TODO(phase 7): send edits of live venues back to review if moderation needs it.
  await venue.save();
  await audit(user.id, "venue.update", "venue", id, { fields: Object.keys(input) });
  return venue;
}

export async function submitVenue(user: AuthUser, id: string) {
  const { venue, business } = await loadOwnedVenue(user, id);
  if (!["draft", "hidden"].includes(venue.status)) {
    throw new HttpError(409, "CONFLICT", `Venue is ${venue.status}`);
  }
  const resources = await ResourceModel.countDocuments({ venueId: venue._id, isActive: true });
  if (resources === 0) {
    throw new HttpError(409, "NO_RESOURCES", "Add at least one active court before submitting");
  }
  if (business.status === "suspended")
    throw new HttpError(409, "CONFLICT", "Business is suspended");
  venue.status = "pending_review";
  venue.reviewNote = undefined;
  await venue.save();
  if (business.status === "draft") {
    business.status = "pending_review";
    business.reviewNote = undefined;
    await business.save();
  }
  await audit(user.id, "venue.submit", "venue", id);
  return venue;
}

export async function listMyVenues(user: AuthUser) {
  const businesses = await BusinessModel.find({ ownerUserIds: oid(user.id) }, { _id: 1 }).lean();
  return VenueModel.find({ businessId: { $in: businesses.map((b) => b._id) } }).sort({
    createdAt: 1,
  });
}

// ---------- resources ----------

async function refreshMinPrice(venueId: Types.ObjectId) {
  const resources = await ResourceModel.find(
    { venueId, isActive: true },
    { pricingRules: 1 },
  ).lean();
  const min = minPricePaise(resources.flatMap((r) => r.pricingRules));
  await VenueModel.updateOne(
    { _id: venueId },
    min === null ? { $unset: { minPricePaise: 1 } } : { $set: { minPricePaise: min } },
  );
}

export async function listResources(user: AuthUser, venueId: string) {
  const { venue } = await loadOwnedVenue(user, venueId);
  return ResourceModel.find({ venueId: venue._id }).sort({ createdAt: 1 });
}

export async function createResource(user: AuthUser, venueId: string, input: CreateResource) {
  const { venue } = await loadOwnedVenue(user, venueId);
  const resource = await ResourceModel.create({ ...input, venueId: venue._id });
  await refreshMinPrice(venue._id);
  await audit(user.id, "resource.create", "resource", String(resource._id), { venueId });
  return resource;
}

async function loadResource(user: AuthUser, venueId: string, resourceId: string) {
  const { venue } = await loadOwnedVenue(user, venueId);
  const resource = await ResourceModel.findOne({ _id: oid(resourceId), venueId: venue._id });
  if (!resource) throw notFound("Court");
  return { venue, resource };
}

export async function updateResource(
  user: AuthUser,
  venueId: string,
  resourceId: string,
  input: UpdateResource,
) {
  const { venue, resource } = await loadResource(user, venueId, resourceId);
  resource.set(input);
  await resource.save();
  await refreshMinPrice(venue._id);
  await audit(user.id, "resource.update", "resource", resourceId, { fields: Object.keys(input) });
  return resource;
}

export async function deleteResource(user: AuthUser, venueId: string, resourceId: string) {
  const { venue, resource } = await loadResource(user, venueId, resourceId);
  // TODO(phase 2): refuse (or deactivate instead) when the court has future bookings.
  await resource.deleteOne();
  await refreshMinPrice(venue._id);
  await audit(user.id, "resource.delete", "resource", resourceId, { venueId });
}
