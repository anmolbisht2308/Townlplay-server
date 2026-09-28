import { venueListQuerySchema, type City, type VenueListQuery } from "@townplay/shared";
import { Router } from "express";
import { z } from "zod";
import { param, validate } from "../middleware/validate.js";
import { CityModel } from "../models/city.js";
import * as listing from "../services/publicListing.js";

const slugSchema = z.string().regex(/^[a-z0-9-]{1,80}$/);
const cityParams = z.object({ slug: slugSchema });
const venueParams = z.object({ city: slugSchema, slug: slugSchema });

export function publicRouter(): Router {
  const router = Router();

  router.get("/cities", async (_req, res) => {
    const cities = await CityModel.find({ isActive: true }).sort({ name: 1 }).lean();
    res.json(
      cities.map((c): City => ({ id: String(c._id), name: c.name, slug: c.slug, state: c.state })),
    );
  });

  router.get(
    "/cities/:slug/venues",
    validate({ params: cityParams, query: venueListQuerySchema }),
    async (req, res) => {
      res.json(await listing.listVenues(param(req, "slug"), res.locals.query as VenueListQuery));
    },
  );

  router.get("/cities/:slug/areas", validate({ params: cityParams }), async (req, res) => {
    res.json(await listing.listAreas(param(req, "slug")));
  });

  router.get("/venues/by-slug/:city/:slug", validate({ params: venueParams }), async (req, res) => {
    res.json(await listing.getPublicVenue(param(req, "city"), param(req, "slug")));
  });

  router.get("/sitemap", async (_req, res) => {
    res.json(await listing.sitemapEntries());
  });

  return router;
}
