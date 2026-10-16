/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as battle from "../battle.js";
import type * as battleCore from "../battleCore.js";
import type * as crons from "../crons.js";
import type * as exchanges from "../exchanges.js";
import type * as gate from "../gate.js";
import type * as luxSmc from "../luxSmc.js";
import type * as panel from "../panel.js";
import type * as report from "../report.js";
import type * as telegram from "../telegram.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  battle: typeof battle;
  battleCore: typeof battleCore;
  crons: typeof crons;
  exchanges: typeof exchanges;
  gate: typeof gate;
  luxSmc: typeof luxSmc;
  panel: typeof panel;
  report: typeof report;
  telegram: typeof telegram;
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
