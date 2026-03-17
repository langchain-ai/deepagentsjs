/**
 * Eval tests for relational data tool usage.
 *
 * Fake users, locations, and foods connected by IDs. The agent receives *only*
 * the lookup/search tools (no filesystem) and must chain them to answer
 * questions.
 */

import * as ls from "langsmith/vitest";
import { beforeEach, expect, vi } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";
import { getDefaultRunner } from "@deepagents/evals";

const runner = getDefaultRunner();

interface User {
  id: number;
  name: string;
  email: string;
  location: number;
  favorite_color: string;
  favorite_foods: number[];
}

interface Location {
  id: number;
  city: string;
  current_time: string;
  current_weather: string;
}

interface Food {
  id: number;
  name: string;
  calories: number;
  allergic_ingredients: string[];
}

const USER_DATA: User[] = [
  {
    id: 1,
    name: "Alice",
    email: "alice@gmail.com",
    location: 1,
    favorite_color: "red",
    favorite_foods: [1, 2, 3],
  },
  {
    id: 21,
    name: "Bob",
    email: "bob@hotmail.com",
    location: 2,
    favorite_color: "orange",
    favorite_foods: [4, 5, 6],
  },
  {
    id: 35,
    name: "Charlie",
    email: "charlie@yahoo.com",
    location: 3,
    favorite_color: "yellow",
    favorite_foods: [3, 7, 2],
  },
  {
    id: 41,
    name: "Donna",
    email: "donna@example.com",
    location: 4,
    favorite_color: "green",
    favorite_foods: [6, 1, 4],
  },
  {
    id: 42,
    name: "Eve",
    email: "eve@example.org",
    location: 5,
    favorite_color: "blue",
    favorite_foods: [5, 7, 4],
  },
  {
    id: 43,
    name: "Frank The Cat",
    email: "frank.the.cat@langchain.dev",
    location: 5,
    favorite_color: "yellow",
    favorite_foods: [3],
  },
];

const LOCATION_DATA: Location[] = [
  {
    id: 1,
    city: "New York",
    current_time: "2023-11-14 10:30 AM",
    current_weather: "Partly Cloudy, Temperature: 68\u00b0F",
  },
  {
    id: 2,
    city: "Los Angeles",
    current_time: "2023-11-14 7:45 AM",
    current_weather: "Sunny, Temperature: 75\u00b0F",
  },
  {
    id: 3,
    city: "Chicago",
    current_time: "2023-11-14 11:15 AM",
    current_weather: "Mostly Cloudy, Temperature: 60\u00b0F",
  },
  {
    id: 4,
    city: "Houston",
    current_time: "2023-11-14 12:00 PM",
    current_weather: "Rainy, Temperature: 55\u00b0F",
  },
  {
    id: 5,
    city: "Miami",
    current_time: "2023-11-14 1:20 PM",
    current_weather: "Partly Cloudy, Temperature: 80\u00b0F",
  },
];

const FOOD_DATA: Food[] = [
  {
    id: 1,
    name: "Pizza",
    calories: 285,
    allergic_ingredients: ["Gluten", "Dairy"],
  },
  {
    id: 2,
    name: "Chocolate",
    calories: 50,
    allergic_ingredients: ["Milk", "Soy"],
  },
  {
    id: 3,
    name: "Sushi",
    calories: 300,
    allergic_ingredients: ["Fish", "Soy"],
  },
  {
    id: 4,
    name: "Burger",
    calories: 350,
    allergic_ingredients: ["Gluten", "Dairy"],
  },
  {
    id: 5,
    name: "Ice Cream",
    calories: 200,
    allergic_ingredients: ["Dairy"],
  },
  {
    id: 6,
    name: "Pasta",
    calories: 180,
    allergic_ingredients: ["Gluten"],
  },
  {
    id: 7,
    name: "Salad",
    calories: 50,
    allergic_ingredients: [],
  },
];

// ---------------------------------------------------------------------------
// Internal helpers (not exposed as tools)
// ---------------------------------------------------------------------------

function similaritySearch(
  data: Array<Record<string, unknown>>,
  query: string,
  key: string,
): Array<{ id: number; [k: string]: unknown }> {
  function score(x: string): number {
    const setX = new Set(x);
    const setQ = new Set(query);
    const intersection = new Set([...setX].filter((c) => setQ.has(c)));
    const union = new Set([...setX, ...setQ]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  const ranked = [...data].sort(
    (a, b) => score(b[key] as string) - score(a[key] as string),
  );
  return ranked.map((d) => ({ id: d.id as number, [key]: d[key] }));
}

function getUser(userId: number): User {
  const user = USER_DATA.find((u) => u.id === userId);
  if (!user) throw new Error(`User ID ${userId} cannot be resolved`);
  return user;
}

function getLocation(locationId: number): Location {
  const loc = LOCATION_DATA.find((l) => l.id === locationId);
  if (!loc) throw new Error(`Location ID ${locationId} cannot be resolved`);
  return loc;
}

function getFood(foodId: number): Food {
  const food = FOOD_DATA.find((f) => f.id === foodId);
  if (!food) throw new Error(`Food ID ${foodId} cannot be resolved`);
  return food;
}

// ---------------------------------------------------------------------------
// Spied tools — each tool wraps its implementation in vi.fn() so tests
// can assert which tools were called and with what arguments.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function spiedTool(
  fn: (...args: any[]) => any,
  config: { name: string; description: string; schema: any },
) {
  const spy = vi.fn(fn);
  return { tool: tool(spy, config), spy };
}

const { tool: getUserName, spy: getUserNameSpy } = spiedTool(
  ({ user_id }) => getUser(user_id).name,
  {
    name: "get_user_name",
    description: "Get the name of the user with the given user ID.",
    schema: z.object({ user_id: z.number().describe("The user's ID.") }),
  },
);

const { tool: listUserIds, spy: listUserIdsSpy } = spiedTool(
  () => USER_DATA.map((u) => u.id),
  {
    name: "list_user_ids",
    description: "List all the user IDs.",
    schema: z.object({}),
  },
);

const { tool: findUsersByName, spy: findUsersByNameSpy } = spiedTool(
  ({ name }) =>
    similaritySearch(
      USER_DATA as unknown as Record<string, unknown>[],
      name,
      "name",
    ),
  {
    name: "find_users_by_name",
    description: "Find users with the given name.",
    schema: z.object({ name: z.string().describe("The name to search for.") }),
  },
);

const { tool: findLocationsByName, spy: findLocationsByNameSpy } = spiedTool(
  ({ city }) =>
    similaritySearch(
      LOCATION_DATA as unknown as Record<string, unknown>[],
      city,
      "city",
    ),
  {
    name: "find_locations_by_name",
    description: "Find locations with the given city name.",
    schema: z.object({
      city: z.string().describe("The city name to search for."),
    }),
  },
);

const { tool: findFoodsByName, spy: findFoodsByNameSpy } = spiedTool(
  ({ food }) =>
    similaritySearch(
      FOOD_DATA as unknown as Record<string, unknown>[],
      food,
      "name",
    ),
  {
    name: "find_foods_by_name",
    description: "Find foods with the given name.",
    schema: z.object({
      food: z.string().describe("The food name to search for."),
    }),
  },
);

const { tool: getUserEmail, spy: getUserEmailSpy } = spiedTool(
  ({ user_id }) => getUser(user_id).email,
  {
    name: "get_user_email",
    description: "Get the email of the user with the given user ID.",
    schema: z.object({ user_id: z.number().describe("The user's ID.") }),
  },
);

const { tool: getUserLocation, spy: getUserLocationSpy } = spiedTool(
  ({ user_id }) => getUser(user_id).location,
  {
    name: "get_user_location",
    description: "Get the location ID of the user with the given user ID.",
    schema: z.object({ user_id: z.number().describe("The user's ID.") }),
  },
);

const { tool: getUserFavoriteColor, spy: getUserFavoriteColorSpy } = spiedTool(
  ({ user_id }) => getUser(user_id).favorite_color,
  {
    name: "get_user_favorite_color",
    description: "Get the favorite color of the user with the given user ID.",
    schema: z.object({ user_id: z.number().describe("The user's ID.") }),
  },
);

const { tool: getUserFavoriteFoods, spy: getUserFavoriteFoodsSpy } = spiedTool(
  ({ user_id }) => getUser(user_id).favorite_foods,
  {
    name: "get_user_favorite_foods",
    description:
      "Get the list of favorite food IDs of the user with the given user ID.",
    schema: z.object({ user_id: z.number().describe("The user's ID.") }),
  },
);

const { tool: getWeatherAtLocation, spy: getWeatherAtLocationSpy } = spiedTool(
  ({ location_id }: { location_id: number }) =>
    getLocation(location_id).current_weather,
  {
    name: "get_weather_at_location",
    description:
      "Get the current weather at the location with the given location ID.",
    schema: z.object({
      location_id: z.number().describe("The location's ID."),
    }),
  },
);

const { tool: getCityForLocation, spy: getCityForLocationSpy } = spiedTool(
  ({ location_id }: { location_id: number }) => getLocation(location_id).city,
  {
    name: "get_city_for_location",
    description: "Get the city for the location with the given location ID.",
    schema: z.object({
      location_id: z.number().describe("The location's ID."),
    }),
  },
);

const { tool: getCurrentTimeForLocation, spy: getCurrentTimeForLocationSpy } =
  spiedTool(
    ({ location_id }: { location_id: number }) =>
      getLocation(location_id).current_time,
    {
      name: "get_current_time_for_location",
      description:
        "Get the current time for the location with the given location ID.",
      schema: z.object({
        location_id: z.number().describe("The location's ID."),
      }),
    },
  );

const { tool: getFoodName, spy: getFoodNameSpy } = spiedTool(
  ({ food_id }: { food_id: number }) => getFood(food_id).name,
  {
    name: "get_food_name",
    description: "Get the name of the food with the given food ID.",
    schema: z.object({ food_id: z.number().describe("The food's ID.") }),
  },
);

const { tool: getFoodCalories, spy: getFoodCaloriesSpy } = spiedTool(
  ({ food_id }: { food_id: number }) => getFood(food_id).calories,
  {
    name: "get_food_calories",
    description:
      "Get the calories per serving for the food with the given food ID.",
    schema: z.object({ food_id: z.number().describe("The food's ID.") }),
  },
);

const { tool: getFoodAllergicIngredients, spy: getFoodAllergicIngredientsSpy } =
  spiedTool(
    ({ food_id }: { food_id: number }) => getFood(food_id).allergic_ingredients,
    {
      name: "get_food_allergic_ingredients",
      description:
        "Get the list of allergic ingredients for the food with the given food ID.",
      schema: z.object({ food_id: z.number().describe("The food's ID.") }),
    },
  );

const { tool: getCurrentUserId, spy: getCurrentUserIdSpy } = spiedTool(
  () => 35,
  {
    name: "get_current_user_id",
    description: "Get the current user's ID.",
    schema: z.object({}),
  },
);

// ---------------------------------------------------------------------------
// All relational-data tools collected for easy use
// ---------------------------------------------------------------------------

const RELATIONAL_TOOLS = [
  getUserName,
  listUserIds,
  findUsersByName,
  findLocationsByName,
  findFoodsByName,
  getUserEmail,
  getUserLocation,
  getUserFavoriteColor,
  getUserFavoriteFoods,
  getWeatherAtLocation,
  getCityForLocation,
  getCurrentTimeForLocation,
  getFoodName,
  getFoodCalories,
  getFoodAllergicIngredients,
  getCurrentUserId,
];

ls.describe(
  "deepagents-js-tool-usage-relational",
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    ls.test(
      "single tool: list user IDs",
      {
        inputs: { query: "What are all the user IDs in the system?" },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("1");
        expect(result).toHaveFinalTextContaining("21");
        expect(result).toHaveFinalTextContaining("35");
        expect(result).toHaveFinalTextContaining("41");
        expect(result).toHaveFinalTextContaining("42");
        expect(result).toHaveFinalTextContaining("43");

        // Spy assertions
        expect(listUserIdsSpy).toHaveBeenCalled();

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "single tool: get user email",
      {
        inputs: { query: "What is the email address of user 21?" },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("bob@hotmail.com");

        // Spy assertions
        expect(getUserEmailSpy).toHaveBeenCalledWith(
          { user_id: 21 },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "single tool: get food calories",
      {
        inputs: { query: "How many calories does food 5 have per serving?" },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("200");

        // Spy assertions
        expect(getFoodCaloriesSpy).toHaveBeenCalledWith(
          { food_id: 5 },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "two tools: user name from current ID",
      {
        inputs: { query: "What is the name of the current user?" },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("Charlie");

        // Spy assertions
        expect(getCurrentUserIdSpy).toHaveBeenCalled();
        expect(getUserNameSpy).toHaveBeenCalledWith(
          { user_id: 35 },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "two tools: city for user",
      {
        inputs: { query: "What city does user 1 live in?" },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("New York");

        // Spy assertions
        expect(getUserLocationSpy).toHaveBeenCalledWith(
          { user_id: 1 },
          expect.anything(),
        );
        expect(getCityForLocationSpy).toHaveBeenCalledWith(
          { location_id: 1 },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "two tools: find user then email",
      {
        inputs: { query: "What is Eve's email address?" },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("eve@example.org");

        // Spy assertions
        expect(findUsersByNameSpy).toHaveBeenCalled();
        expect(getUserEmailSpy).toHaveBeenCalledWith(
          { user_id: 42 },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "three tools: current user city",
      {
        inputs: { query: "What city does the current user live in?" },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("Chicago");

        // Spy assertions
        expect(getCurrentUserIdSpy).toHaveBeenCalled();
        expect(getUserLocationSpy).toHaveBeenCalledWith(
          { user_id: 35 },
          expect.anything(),
        );
        expect(getCityForLocationSpy).toHaveBeenCalledWith(
          { location_id: 3 },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "three tools: find user then city",
      {
        inputs: { query: "What city does Alice live in?" },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("New York");

        // Spy assertions
        expect(findUsersByNameSpy).toHaveBeenCalled();
        expect(getUserLocationSpy).toHaveBeenCalledWith(
          { user_id: 1 },
          expect.anything(),
        );
        expect(getCityForLocationSpy).toHaveBeenCalledWith(
          { location_id: 1 },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "three tools: current user weather",
      {
        inputs: {
          query: "What is the current weather where the current user lives?",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("60", true);

        // Spy assertions
        expect(getCurrentUserIdSpy).toHaveBeenCalled();
        expect(getUserLocationSpy).toHaveBeenCalledWith(
          { user_id: 35 },
          expect.anything(),
        );
        expect(getWeatherAtLocationSpy).toHaveBeenCalledWith(
          {
            location_id: 3,
          },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "four tools: current user favorite food names",
      {
        inputs: {
          query: "What are the names of the current user's favorite foods?",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        // 1: get_current_user_id -> 35
        // 2: get_user_favorite_foods(35) -> [3, 7, 2]
        // 3: get_food_name(3), get_food_name(7), get_food_name(2) in parallel
        // 4: answer
        expect(result).toHaveFinalTextContaining("Sushi");
        expect(result).toHaveFinalTextContaining("Salad");
        expect(result).toHaveFinalTextContaining("Chocolate");

        // Spy assertions
        expect(getCurrentUserIdSpy).toHaveBeenCalled();
        expect(getUserFavoriteFoodsSpy).toHaveBeenCalledWith(
          { user_id: 35 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 3 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 7 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 2 },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "four tools: find user food name and calories",
      {
        inputs: {
          query:
            "How many calories per serving does Frank The Cat's favorite food have? Also tell me the name of the food.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        // 1: find_users_by_name("Frank The Cat")
        // 2: get_user_favorite_foods(43) -> [3]
        // 3: get_food_name(3) and get_food_calories(3) in parallel
        // 4: answer
        expect(result).toHaveFinalTextContaining("Sushi");
        expect(result).toHaveFinalTextContaining("300");

        // Spy assertions
        expect(findUsersByNameSpy).toHaveBeenCalled();
        expect(getUserFavoriteFoodsSpy).toHaveBeenCalledWith(
          { user_id: 43 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 3 },
          expect.anything(),
        );
        expect(getFoodCaloriesSpy).toHaveBeenCalledWith(
          { food_id: 3 },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "four tools: current user location time and weather",
      {
        inputs: {
          query:
            "What is the current time and weather where the current user lives?",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        // 1: get_current_user_id -> 35
        // 2: get_user_location(35) -> 3
        // 3: get_current_time_for_location(3) and get_weather_at_location(3) in parallel
        // 4: answer
        expect(result).toHaveFinalTextContaining("11:15");
        expect(result).toHaveFinalTextContaining("60", true);

        // Spy assertions
        expect(getCurrentUserIdSpy).toHaveBeenCalled();
        expect(getUserLocationSpy).toHaveBeenCalledWith(
          { user_id: 35 },
          expect.anything(),
        );
        expect(getCurrentTimeForLocationSpy).toHaveBeenCalledWith(
          {
            location_id: 3,
          },
          expect.anything(),
        );
        expect(getWeatherAtLocationSpy).toHaveBeenCalledWith(
          {
            location_id: 3,
          },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "five steps: current user food names and calories",
      {
        inputs: {
          query:
            "For each of the current user's favorite foods, tell me the food name and how many calories per serving it has.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        // 1: get_current_user_id -> 35
        // 2: get_user_favorite_foods(35) -> [3, 7, 2]
        // 3: get_food_name + get_food_calories for each food ID, all 6 in parallel
        // 4: answer
        expect(result).toHaveFinalTextContaining("Sushi");
        expect(result).toHaveFinalTextContaining("300");
        expect(result).toHaveFinalTextContaining("Salad");
        expect(result).toHaveFinalTextContaining("50");
        expect(result).toHaveFinalTextContaining("Chocolate");

        // Spy assertions
        expect(getCurrentUserIdSpy).toHaveBeenCalled();
        expect(getUserFavoriteFoodsSpy).toHaveBeenCalledWith(
          { user_id: 35 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 3 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 7 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 2 },
          expect.anything(),
        );
        expect(getFoodCaloriesSpy).toHaveBeenCalledWith(
          { food_id: 3 },
          expect.anything(),
        );
        expect(getFoodCaloriesSpy).toHaveBeenCalledWith(
          { food_id: 7 },
          expect.anything(),
        );
        expect(getFoodCaloriesSpy).toHaveBeenCalledWith(
          { food_id: 2 },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "four steps: find user city and weather",
      {
        inputs: {
          query:
            "Find Bob and tell me what city he lives in, the current time there, and the current weather.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        // 1: find_users_by_name("Bob")
        // 2: get_user_location(21) -> 2
        // 3: get_city_for_location(2), get_current_time_for_location(2),
        //    get_weather_at_location(2) in parallel
        // 4: answer
        expect(result).toHaveFinalTextContaining("Los Angeles");
        expect(result).toHaveFinalTextContaining("7:45");
        expect(result).toHaveFinalTextContaining("75", true);

        // Spy assertions
        expect(findUsersByNameSpy).toHaveBeenCalled();
        expect(getUserLocationSpy).toHaveBeenCalledWith(
          { user_id: 21 },
          expect.anything(),
        );
        expect(getCityForLocationSpy).toHaveBeenCalledWith(
          { location_id: 2 },
          expect.anything(),
        );
        expect(getCurrentTimeForLocationSpy).toHaveBeenCalledWith(
          {
            location_id: 2,
          },
          expect.anything(),
        );
        expect(getWeatherAtLocationSpy).toHaveBeenCalledWith(
          {
            location_id: 2,
          },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "four steps: find user food allergies",
      {
        inputs: {
          query:
            "What are the names and allergic ingredients of all of Alice's favorite foods?",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        // 1: find_users_by_name("Alice")
        // 2: get_user_favorite_foods(1) -> [1, 2, 3]
        // 3: get_food_name + get_food_allergic_ingredients for each, all 6 in parallel
        // 4: answer
        expect(result).toHaveFinalTextContaining("Pizza");
        expect(result).toHaveFinalTextContaining("Gluten");
        expect(result).toHaveFinalTextContaining("Chocolate");
        expect(result).toHaveFinalTextContaining("Milk");
        expect(result).toHaveFinalTextContaining("Sushi");
        expect(result).toHaveFinalTextContaining("Fish");

        // Spy assertions
        expect(findUsersByNameSpy).toHaveBeenCalled();
        expect(getUserFavoriteFoodsSpy).toHaveBeenCalledWith(
          { user_id: 1 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 1 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 2 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 3 },
          expect.anything(),
        );
        expect(getFoodAllergicIngredientsSpy).toHaveBeenCalledWith(
          {
            food_id: 1,
          },
          expect.anything(),
        );
        expect(getFoodAllergicIngredientsSpy).toHaveBeenCalledWith(
          {
            food_id: 2,
          },
          expect.anything(),
        );
        expect(getFoodAllergicIngredientsSpy).toHaveBeenCalledWith(
          {
            food_id: 3,
          },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "four steps: current user food names calories and allergies",
      {
        inputs: {
          query:
            "For each of the current user's favorite foods, tell me the food name, calories per serving, and allergic ingredients.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        // 1: get_current_user_id -> 35
        // 2: get_user_favorite_foods(35) -> [3, 7, 2]
        // 3: get_food_name, get_food_calories, get_food_allergic_ingredients
        //    for each food ID, all 9 in parallel
        // 4: answer
        expect(result).toHaveFinalTextContaining("Sushi");
        expect(result).toHaveFinalTextContaining("300");
        expect(result).toHaveFinalTextContaining("Fish");
        expect(result).toHaveFinalTextContaining("Salad");
        expect(result).toHaveFinalTextContaining("Chocolate");
        expect(result).toHaveFinalTextContaining("Milk");

        // Spy assertions
        expect(getCurrentUserIdSpy).toHaveBeenCalled();
        expect(getUserFavoriteFoodsSpy).toHaveBeenCalledWith(
          { user_id: 35 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 3 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 7 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 2 },
          expect.anything(),
        );
        expect(getFoodCaloriesSpy).toHaveBeenCalledWith(
          { food_id: 3 },
          expect.anything(),
        );
        expect(getFoodCaloriesSpy).toHaveBeenCalledWith(
          { food_id: 7 },
          expect.anything(),
        );
        expect(getFoodCaloriesSpy).toHaveBeenCalledWith(
          { food_id: 2 },
          expect.anything(),
        );
        expect(getFoodAllergicIngredientsSpy).toHaveBeenCalledWith(
          {
            food_id: 3,
          },
          expect.anything(),
        );
        expect(getFoodAllergicIngredientsSpy).toHaveBeenCalledWith(
          {
            food_id: 7,
          },
          expect.anything(),
        );
        expect(getFoodAllergicIngredientsSpy).toHaveBeenCalledWith(
          {
            food_id: 2,
          },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "four steps: find user city weather time and food details",
      {
        inputs: {
          query:
            "Find Donna and tell me which city she lives in, the current weather and time there, and the names and calories of all her favorite foods.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        // 1: find_users_by_name("Donna")
        // 2: get_user_location(41) and get_user_favorite_foods(41) in parallel
        // 3: get_city_for_location(4), get_current_time_for_location(4),
        //    get_weather_at_location(4), get_food_name for each food,
        //    get_food_calories for each food — all 9 in parallel
        // 4: answer
        expect(result).toHaveFinalTextContaining("Houston");
        expect(result).toHaveFinalTextContaining("12:00");
        expect(result).toHaveFinalTextContaining("55", true);
        expect(result).toHaveFinalTextContaining("Pasta");
        expect(result).toHaveFinalTextContaining("Pizza");
        expect(result).toHaveFinalTextContaining("Burger");
        expect(result).toHaveFinalTextContaining("180");
        expect(result).toHaveFinalTextContaining("285");
        expect(result).toHaveFinalTextContaining("350");

        // Spy assertions
        expect(findUsersByNameSpy).toHaveBeenCalled();
        expect(getUserLocationSpy).toHaveBeenCalledWith(
          { user_id: 41 },
          expect.anything(),
        );
        expect(getUserFavoriteFoodsSpy).toHaveBeenCalledWith(
          { user_id: 41 },
          expect.anything(),
        );
        expect(getCityForLocationSpy).toHaveBeenCalledWith(
          { location_id: 4 },
          expect.anything(),
        );
        expect(getCurrentTimeForLocationSpy).toHaveBeenCalledWith(
          {
            location_id: 4,
          },
          expect.anything(),
        );
        expect(getWeatherAtLocationSpy).toHaveBeenCalledWith(
          {
            location_id: 4,
          },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 6 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 1 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 4 },
          expect.anything(),
        );
        expect(getFoodCaloriesSpy).toHaveBeenCalledWith(
          { food_id: 6 },
          expect.anything(),
        );
        expect(getFoodCaloriesSpy).toHaveBeenCalledWith(
          { food_id: 1 },
          expect.anything(),
        );
        expect(getFoodCaloriesSpy).toHaveBeenCalledWith(
          { food_id: 4 },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "four steps: find user email city foods calories and allergies",
      {
        inputs: {
          query:
            "Find Eve and tell me her email address, what city she lives in, and for each of her favorite foods, give the food name, calories per serving, and allergic ingredients.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: RELATIONAL_TOOLS })
          .run({ query: inputs.query });

        // 1: find_users_by_name("Eve")
        // 2: get_user_email(42), get_user_location(42), get_user_favorite_foods(42) in parallel
        // 3: get_city_for_location(5), get_food_name/calories/allergic_ingredients
        //    for each food ID — all 10 in parallel
        // 4: answer
        expect(result).toHaveFinalTextContaining("eve@example.org");
        expect(result).toHaveFinalTextContaining("Miami");
        expect(result).toHaveFinalTextContaining("Ice Cream");
        expect(result).toHaveFinalTextContaining("200");
        expect(result).toHaveFinalTextContaining("Dairy");
        expect(result).toHaveFinalTextContaining("Salad");
        expect(result).toHaveFinalTextContaining("Burger");
        expect(result).toHaveFinalTextContaining("350");
        expect(result).toHaveFinalTextContaining("Gluten");

        // Spy assertions
        expect(findUsersByNameSpy).toHaveBeenCalled();
        expect(getUserEmailSpy).toHaveBeenCalledWith(
          { user_id: 42 },
          expect.anything(),
        );
        expect(getUserLocationSpy).toHaveBeenCalledWith(
          { user_id: 42 },
          expect.anything(),
        );
        expect(getUserFavoriteFoodsSpy).toHaveBeenCalledWith(
          { user_id: 42 },
          expect.anything(),
        );
        expect(getCityForLocationSpy).toHaveBeenCalledWith(
          { location_id: 5 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 5 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 7 },
          expect.anything(),
        );
        expect(getFoodNameSpy).toHaveBeenCalledWith(
          { food_id: 4 },
          expect.anything(),
        );
        expect(getFoodCaloriesSpy).toHaveBeenCalledWith(
          { food_id: 5 },
          expect.anything(),
        );
        expect(getFoodCaloriesSpy).toHaveBeenCalledWith(
          { food_id: 7 },
          expect.anything(),
        );
        expect(getFoodCaloriesSpy).toHaveBeenCalledWith(
          { food_id: 4 },
          expect.anything(),
        );
        expect(getFoodAllergicIngredientsSpy).toHaveBeenCalledWith(
          {
            food_id: 5,
          },
          expect.anything(),
        );
        expect(getFoodAllergicIngredientsSpy).toHaveBeenCalledWith(
          {
            food_id: 7,
          },
          expect.anything(),
        );
        expect(getFoodAllergicIngredientsSpy).toHaveBeenCalledWith(
          {
            food_id: 4,
          },
          expect.anything(),
        );

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );
  },
  { projectName: runner.name, upsert: true },
);
