import {
  createBusinessSchema,
  createResourceSchema,
  createVenueSchema,
  idParamsSchema,
  objectIdSchema,
  updateBusinessSchema,
  updateResourceSchema,
  updateVenueSchema,
  uploadSignRequestSchema,
  type CreateBusiness,
  type CreateResource,
  type CreateVenue,
  type UpdateBusiness,
  type UpdateResource,
  type UpdateVenue,
} from "@townplay/shared";
import { Router } from "express";
import { z } from "zod";
import type { Auth } from "../auth/auth.js";
import { toBusiness, toResource, toVenue } from "../lib/dto.js";
import { HttpError } from "../lib/httpError.js";
import { requireAuth, type AuthUser } from "../middleware/auth.js";
import { param, validate } from "../middleware/validate.js";
import * as listings from "../services/listings.js";
import { signUpload, type CloudinaryConfig } from "../services/uploads.js";

const resourceParams = z.object({ id: objectIdSchema, resourceId: objectIdSchema });

/** Owner-side listing management. Ownership is enforced in services/listings.ts. */
export function ownerRouter(auth: Auth, cloudinary: CloudinaryConfig | undefined): Router {
  const router = Router();
  const signedIn = requireAuth(auth);
  const me = (req: { user?: AuthUser }) => req.user!;

  router.get("/businesses/mine", signedIn, async (req, res) => {
    res.json((await listings.listMyBusinesses(me(req))).map(toBusiness));
  });
  router.post(
    "/businesses",
    signedIn,
    validate({ body: createBusinessSchema }),
    async (req, res) => {
      res
        .status(201)
        .json(toBusiness(await listings.createBusiness(me(req), req.body as CreateBusiness)));
    },
  );
  router.patch(
    "/businesses/:id",
    signedIn,
    validate({ params: idParamsSchema, body: updateBusinessSchema }),
    async (req, res) => {
      res.json(
        toBusiness(
          await listings.updateBusiness(me(req), param(req, "id"), req.body as UpdateBusiness),
        ),
      );
    },
  );

  router.get("/venues/mine", signedIn, async (req, res) => {
    res.json((await listings.listMyVenues(me(req))).map(toVenue));
  });
  router.post("/venues", signedIn, validate({ body: createVenueSchema }), async (req, res) => {
    const venue = await listings.createVenue(me(req), req.body as CreateVenue, cloudinary);
    res.status(201).json(toVenue(venue));
  });
  router.get("/venues/:id", signedIn, validate({ params: idParamsSchema }), async (req, res) => {
    res.json(toVenue((await listings.loadOwnedVenue(me(req), param(req, "id"))).venue));
  });
  router.patch(
    "/venues/:id",
    signedIn,
    validate({ params: idParamsSchema, body: updateVenueSchema }),
    async (req, res) => {
      const venue = await listings.updateVenue(
        me(req),
        param(req, "id"),
        req.body as UpdateVenue,
        cloudinary,
      );
      res.json(toVenue(venue));
    },
  );
  router.post(
    "/venues/:id/submit",
    signedIn,
    validate({ params: idParamsSchema }),
    async (req, res) => {
      res.json(toVenue(await listings.submitVenue(me(req), param(req, "id"))));
    },
  );

  router.get(
    "/venues/:id/resources",
    signedIn,
    validate({ params: idParamsSchema }),
    async (req, res) => {
      res.json((await listings.listResources(me(req), param(req, "id"))).map(toResource));
    },
  );
  router.post(
    "/venues/:id/resources",
    signedIn,
    validate({ params: idParamsSchema, body: createResourceSchema }),
    async (req, res) => {
      const resource = await listings.createResource(
        me(req),
        param(req, "id"),
        req.body as CreateResource,
      );
      res.status(201).json(toResource(resource));
    },
  );
  router.patch(
    "/venues/:id/resources/:resourceId",
    signedIn,
    validate({ params: resourceParams, body: updateResourceSchema }),
    async (req, res) => {
      const resource = await listings.updateResource(
        me(req),
        param(req, "id"),
        param(req, "resourceId"),
        req.body as UpdateResource,
      );
      res.json(toResource(resource));
    },
  );
  router.delete(
    "/venues/:id/resources/:resourceId",
    signedIn,
    validate({ params: resourceParams }),
    async (req, res) => {
      await listings.deleteResource(me(req), param(req, "id"), param(req, "resourceId"));
      res.status(204).end();
    },
  );

  router.post(
    "/uploads/sign",
    signedIn,
    validate({ body: uploadSignRequestSchema }),
    (req, res) => {
      if (!cloudinary)
        throw new HttpError(503, "UPLOADS_DISABLED", "Photo uploads are not configured");
      res.json(signUpload(cloudinary, `townplay/venues/${me(req).id}`));
    },
  );

  return router;
}
