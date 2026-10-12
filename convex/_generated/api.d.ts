/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as alerts from "../alerts.js";
import type * as crons from "../crons.js";
import type * as exchanges from "../exchanges.js";
import type * as gate from "../gate.js";
import type * as market from "../market.js";
import type * as paper from "../paper.js";
import type * as rulesAdmin from "../rulesAdmin.js";
import type * as smc from "../smc.js";
import type * as smcCore from "../smcCore.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  alerts: typeof alerts;
  crons: typeof crons;
  exchanges: typeof exchanges;
  gate: typeof gate;
  market: typeof market;
  paper: typeof paper;
  rulesAdmin: typeof rulesAdmin;
  smc: typeof smc;
  smcCore: typeof smcCore;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
