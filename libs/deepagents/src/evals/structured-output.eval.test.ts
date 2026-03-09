import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { tool, toolStrategy } from "langchain";
import type { StructuredTool } from "@langchain/core/tools";
import { z } from "zod/v4";
import { createDeepAgent, runAgent } from "./index.js";
import { createQuickJSMiddleware } from "@langchain/quickjs";

// ---------------------------------------------------------------------------
// Fake tool data
// ---------------------------------------------------------------------------

const CITY_DATA: Record<string, Record<string, unknown>> = {
  Tokyo: {
    population: 13_960_000,
    gdp: 1_920_000_000_000,
    area_sq_km: 2_194,
    timezone: "Asia/Tokyo",
    mayor: "Yuriko Koike",
    founded_year: 1457,
    elevation: 40,
    avg_temperature: 15.4,
    primary_industry: "Finance",
    description:
      "Tokyo is the capital of Japan and one of the most densely populated metropolitan areas in the world. Its skyline is a mix of ultramodern skyscrapers and historic temples. The city serves as a global hub for technology, culture, and commerce.",
    notable_landmarks: "Tokyo Tower, Senso-ji Temple, Shibuya Crossing",
  },
  Seoul: {
    population: 9_776_000,
    gdp: 980_000_000_000,
    area_sq_km: 605,
    timezone: "Asia/Seoul",
    mayor: "Oh Se-hoon",
    founded_year: -18,
    elevation: 38,
    avg_temperature: 12.5,
    primary_industry: "Electronics",
    description:
      "Seoul is the capital of South Korea and a leading global technology hub. The Han River bisects the city into northern and southern halves, each with distinct character. It blends centuries-old palaces with cutting-edge digital infrastructure.",
    notable_landmarks: "Gyeongbokgung Palace, N Seoul Tower, Bukchon Hanok Village",
  },
  London: {
    population: 8_982_000,
    gdp: 850_000_000_000,
    area_sq_km: 1_572,
    timezone: "Europe/London",
    mayor: "Sadiq Khan",
    founded_year: 43,
    elevation: 11,
    avg_temperature: 11.3,
    primary_industry: "Financial Services",
    description:
      "London is the capital and largest city of England and the United Kingdom. As one of the world's foremost financial centres it drives significant portions of European commerce. Its cultural diversity is reflected in over 300 languages spoken across the city.",
    notable_landmarks: "Big Ben, Tower Bridge, Buckingham Palace",
  },
  Paris: {
    population: 2_161_000,
    gdp: 770_000_000_000,
    area_sq_km: 105,
    timezone: "Europe/Paris",
    mayor: "Anne Hidalgo",
    founded_year: -250,
    elevation: 35,
    avg_temperature: 12.0,
    primary_industry: "Tourism",
    description:
      "Paris is the capital of France and is renowned for its art, fashion, gastronomy, and culture. The city's 19th-century cityscape is crisscrossed by wide boulevards and the River Seine. It attracts more than 30 million visitors annually making it one of the most visited destinations on the planet.",
    notable_landmarks: "Eiffel Tower, Louvre Museum, Notre-Dame Cathedral",
  },
  Mumbai: {
    population: 12_478_000,
    gdp: 310_000_000_000,
    area_sq_km: 603,
    timezone: "Asia/Kolkata",
    mayor: "Kishori Pednekar",
    founded_year: 1507,
    elevation: 14,
    avg_temperature: 27.2,
    primary_industry: "Entertainment",
    description:
      "Mumbai is the financial capital of India and home to Bollywood, the world's largest film industry by number of films produced. The city sits on a narrow peninsula surrounded by the Arabian Sea and is known for its contrasts of extreme wealth and poverty. Mumbai's stock exchange drives much of India's economic activity.",
    notable_landmarks: "Gateway of India, Marine Drive, Chhatrapati Shivaji Terminus",
  },
  "São Paulo": {
    population: 12_325_000,
    gdp: 650_000_000_000,
    area_sq_km: 1_521,
    timezone: "America/Sao_Paulo",
    mayor: "Ricardo Nunes",
    founded_year: 1554,
    elevation: 760,
    avg_temperature: 19.3,
    primary_industry: "Manufacturing",
    description:
      "São Paulo is the largest city in South America and serves as Brazil's economic engine. It is an enormous multicultural metropolis with large Italian, Japanese, and Arab communities. The city's Avenida Paulista is its most iconic street, lined with skyscrapers and cultural institutions.",
    notable_landmarks: "Ibirapuera Park, São Paulo Museum of Art, Pinacoteca",
  },
  Sydney: {
    population: 5_312_000,
    gdp: 440_000_000_000,
    area_sq_km: 12_368,
    timezone: "Australia/Sydney",
    mayor: "Clover Moore",
    founded_year: 1788,
    elevation: 58,
    avg_temperature: 18.4,
    primary_industry: "Mining Services",
    description:
      "Sydney is the most populous city in Australia and is famous for its harbour, its Opera House, and its bridge. The city enjoys a warm climate and an outdoor lifestyle centred on its many beaches. It serves as a gateway to the Asia-Pacific region for international commerce.",
    notable_landmarks: "Sydney Opera House, Harbour Bridge, Bondi Beach",
  },
  Singapore: {
    population: 5_686_000,
    gdp: 397_000_000_000,
    area_sq_km: 733,
    timezone: "Asia/Singapore",
    mayor: "Low Yen Ling",
    founded_year: 1819,
    elevation: 15,
    avg_temperature: 27.0,
    primary_industry: "Trade & Logistics",
    description:
      "Singapore is a city-state in Southeast Asia known for its rapid economic development and immaculate urban planning. Despite its tiny land area it ranks among the world's wealthiest nations by GDP per capita. The city is a major shipping hub controlling access to the Strait of Malacca.",
    notable_landmarks: "Marina Bay Sands, Gardens by the Bay, Merlion Park",
  },
};

const getCityData = tool(
  async (input) => {
    const data = CITY_DATA[input.city];
    if (!data) return `No data found for city: ${input.city}`;
    return (
      `Here is the comprehensive data report for ${input.city}:\n\n` +
      `Population: The city of ${input.city} has an estimated population of ${(data.population as number).toLocaleString()} residents ` +
      `spread across an area of ${(data.area_sq_km as number).toLocaleString()} square kilometres. ` +
      `The gross domestic product stands at approximately $${(data.gdp as number).toLocaleString()} USD. ` +
      `The city operates in the ${data.timezone} timezone and the current mayor is ${data.mayor}. ` +
      `It was founded in the year ${data.founded_year} and sits at an elevation of ${data.elevation} metres above sea level. ` +
      `The average annual temperature is ${data.avg_temperature}°C. ` +
      `The primary industry driving the local economy is ${data.primary_industry}.\n\n` +
      `${data.description}\n\n` +
      `Notable landmarks include: ${data.notable_landmarks}.`
    );
  },
  {
    name: "get_city_data",
    description:
      "Retrieve comprehensive data about a city including population, GDP, area, timezone, mayor, founding year, elevation, temperature, industry, and landmarks.",
    schema: z.object({ city: z.string().describe("City name") }),
  },
);

// Ground truth for Eval A assertions:
// Population density = population / area_sq_km
// Paris: 2161000/105 = 20581  <-- highest
// Mumbai: 12478000/603 = 20693 <-- actually highest! Let me recalculate all.
// Tokyo: 13960000/2194 = 6361
// Seoul: 9776000/605 = 16158
// London: 8982000/1572 = 5714
// Paris: 2161000/105 = 20581
// Mumbai: 12478000/603 = 20693
// Sao Paulo: 12325000/1521 = 8103
// Sydney: 5312000/12368 = 429
// Singapore: 5686000/733 = 7758
//
// Highest density: Mumbai (20693)
// Mumbai timezone: Asia/Kolkata
// Lowest population: Paris (2161000), GDP = 770_000_000_000

const FLIGHT_DATA: Record<string, Array<Record<string, unknown>>> = {
  "NYC-London": [
    { airline: "British Airways", price: 780, duration_hours: 7.5, destination_city: "London" },
    { airline: "Delta", price: 820, duration_hours: 8.0, destination_city: "London" },
    { airline: "Virgin Atlantic", price: 695, duration_hours: 7.0, destination_city: "London" },
    { airline: "United", price: 910, duration_hours: 8.5, destination_city: "London" },
  ],
  "NYC-Paris": [
    { airline: "Air France", price: 650, duration_hours: 8.0, destination_city: "Paris" },
    { airline: "Delta", price: 720, duration_hours: 8.5, destination_city: "Paris" },
    { airline: "Norwegian", price: 480, duration_hours: 9.0, destination_city: "Paris" },
    { airline: "United", price: 810, duration_hours: 8.0, destination_city: "Paris" },
  ],
  "NYC-Tokyo": [
    { airline: "ANA", price: 1100, duration_hours: 14.0, destination_city: "Tokyo" },
    { airline: "JAL", price: 1050, duration_hours: 13.5, destination_city: "Tokyo" },
    { airline: "Delta", price: 990, duration_hours: 15.0, destination_city: "Tokyo" },
    { airline: "United", price: 1200, duration_hours: 14.5, destination_city: "Tokyo" },
  ],
};

const searchFlights = tool(
  async (input) => {
    const key = `${input.origin}-${input.destination}`;
    const flights = FLIGHT_DATA[key];
    if (!flights) return `No flights found from ${input.origin} to ${input.destination}.`;
    const lines = flights.map(
      (f) =>
        `Flight operated by ${f.airline}: The ticket costs $${f.price} for a journey of ${f.duration_hours} hours ` +
        `arriving in ${f.destination_city}. This is a direct flight with standard amenities included in the fare. ` +
        `Baggage allowance is 23kg checked and 7kg carry-on.`,
    );
    return `Found ${flights.length} flights from ${input.origin} to ${input.destination}:\n\n${lines.join("\n\n")}`;
  },
  {
    name: "search_flights",
    description: "Search for available flights between two cities. Returns airline, price, duration, and destination info.",
    schema: z.object({
      origin: z.string().describe("Origin city code (e.g. NYC)"),
      destination: z.string().describe("Destination city name (e.g. London)"),
    }),
  },
);

const HOTEL_DATA: Record<string, Array<Record<string, unknown>>> = {
  London: [
    { name: "The Savoy", price_per_night: 450, rating: 4.8, availability: true },
    { name: "Premier Inn Tower Bridge", price_per_night: 120, rating: 4.2, availability: true },
    { name: "The Ritz London", price_per_night: 650, rating: 4.9, availability: false },
  ],
  Paris: [
    { name: "Hôtel Plaza Athénée", price_per_night: 580, rating: 4.9, availability: true },
    { name: "Ibis Paris Bastille", price_per_night: 95, rating: 3.8, availability: true },
    { name: "Le Meurice", price_per_night: 720, rating: 4.7, availability: false },
  ],
  Tokyo: [
    { name: "Park Hyatt Tokyo", price_per_night: 380, rating: 4.7, availability: true },
    { name: "APA Hotel Shinjuku", price_per_night: 85, rating: 3.9, availability: true },
    { name: "Aman Tokyo", price_per_night: 900, rating: 4.9, availability: true },
  ],
};

const checkHotels = tool(
  async (input) => {
    const hotels = HOTEL_DATA[input.city];
    if (!hotels) return `No hotel data available for ${input.city}.`;
    const lines = hotels.map(
      (h) =>
        `${h.name}: This well-known hotel offers rooms at $${h.price_per_night} per night. ` +
        `Guests rate it ${h.rating} out of 5 based on thousands of verified reviews. ` +
        `Current availability: ${h.availability ? "Rooms are available for your dates" : "Unfortunately fully booked for the requested dates"}. ` +
        `The property features complimentary wifi, concierge service, and a fitness centre.`,
    );
    return `Hotel options in ${input.city}:\n\n${lines.join("\n\n")}`;
  },
  {
    name: "check_hotels",
    description: "Check hotel availability and pricing in a specific city. Returns hotel name, price per night, rating, and availability.",
    schema: z.object({
      city: z.string().describe("City name to search hotels in"),
    }),
  },
);

// Ground truth for Eval B:
// Cheapest flight across all: NYC-Paris Norwegian at $480
// Hotels in Paris available: Plaza Athénée (4.9, available), Ibis (3.8, available)
// Highest-rated available: Hôtel Plaza Athénée

const CANDIDATE_DATA: Record<string, Record<string, unknown>> = {
  "Candidate A": {
    name: "Candidate A",
    score: 91,
    risk_level: "high",
    time_to_completion: 14,
    cost: 5200,
    specialty: "Machine Learning",
  },
  "Candidate B": {
    name: "Candidate B",
    score: 87,
    risk_level: "low",
    time_to_completion: 21,
    cost: 4500,
    specialty: "Data Engineering",
  },
  "Candidate C": {
    name: "Candidate C",
    score: 87,
    risk_level: "medium",
    time_to_completion: 18,
    cost: 4800,
    specialty: "Backend Systems",
  },
  "Candidate D": {
    name: "Candidate D",
    score: 83,
    risk_level: "low",
    time_to_completion: 10,
    cost: 3200,
    specialty: "Frontend Development",
  },
};

const evaluateCandidate = tool(
  async (input) => {
    const data = CANDIDATE_DATA[input.name];
    if (!data) return `No candidate found with name: ${input.name}`;
    return (
      `Evaluation report for ${data.name}:\n\n` +
      `This candidate achieved an overall competency score of ${data.score} out of 100 on the standardised assessment. ` +
      `The risk assessment panel categorised them as "${data.risk_level}" risk based on reference checks and background verification. ` +
      `They estimate they can complete the project deliverables in approximately ${data.time_to_completion} business days. ` +
      `The total engagement cost would be $${(data.cost as number).toLocaleString()} including all fees and expenses. ` +
      `Their primary area of expertise is ${data.specialty}, where they have demonstrated significant depth of knowledge ` +
      `through multiple prior engagements with Fortune 500 clients.`
    );
  },
  {
    name: "evaluate_candidate",
    description: "Evaluate a candidate and return their score, risk level, time to completion, cost, and specialty.",
    schema: z.object({
      name: z.string().describe("Candidate name (e.g. 'Candidate A')"),
    }),
  },
);

// Ground truth for Eval C:
// A: score 91, risk high -> disqualified
// B: score 87, risk low, cost 4500
// C: score 87, risk medium, cost 4800
// Tie on score (87 vs 87), B wins on lower cost ($4500 < $4800)
// Winner: Candidate B

// ---------------------------------------------------------------------------
// Schemas for structured output
// ---------------------------------------------------------------------------

const citySchema = z.object({
  city: z.string().describe("City name"),
  population: z.number().describe("Population count"),
  gdp: z.number().describe("GDP in USD"),
  area_sq_km: z.number().describe("Area in square kilometres"),
  timezone: z.string().describe("IANA timezone identifier"),
  mayor: z.string().describe("Current mayor"),
  founded_year: z.number().describe("Year the city was founded"),
  elevation: z.number().describe("Elevation in metres"),
  avg_temperature: z.number().describe("Average annual temperature in Celsius"),
  primary_industry: z.string().describe("Primary industry"),
  description: z.string().describe("Short description of the city"),
  notable_landmarks: z.string().describe("Notable landmarks"),
});

const flightSchema = z.object({
  airline: z.string().describe("Airline name"),
  price: z.number().describe("Ticket price in USD"),
  duration_hours: z.number().describe("Flight duration in hours"),
  destination_city: z.string().describe("Destination city name"),
});

const candidateSchema = z.object({
  name: z.string().describe("Candidate name"),
  score: z.number().describe("Assessment score out of 100"),
  risk_level: z.string().describe("Risk level: low, medium, or high"),
  time_to_completion: z.number().describe("Estimated days to complete"),
  cost: z.number().describe("Total engagement cost in USD"),
  specialty: z.string().describe("Primary area of expertise"),
});

// ---------------------------------------------------------------------------
// Agent factory
// ---------------------------------------------------------------------------

function createEvalAgents(params: {
  subagentName: string;
  description: string;
  systemPrompt: string;
  tools: StructuredTool[];
  schema: z.ZodObject<any>;
  supervisorContext: string;
  dynamicSchemaJson: string;
}) {
  const staticAgent = createDeepAgent({
    systemPrompt:
      `${params.supervisorContext}\n\n` +
      `You have a subagent called "${params.subagentName}". ` +
      `Use the task tool with subagent_type "${params.subagentName}" to delegate work. ` +
      `The subagent already has a built-in structured response format — do NOT pass response_schema.`,
    subagents: [
      {
        name: params.subagentName,
        description: params.description,
        systemPrompt: params.systemPrompt,
        tools: params.tools,
        responseFormat: toolStrategy(params.schema),
      },
    ],
  });

  const dynamicAgent = createDeepAgent({
    systemPrompt:
      `${params.supervisorContext}\n\n` +
      `You have a subagent called "${params.subagentName}". ` +
      `Use the task tool with subagent_type "${params.subagentName}" to delegate work. ` +
      `You MUST include a response_schema parameter in every task call with this JSON schema:\n` +
      `${params.dynamicSchemaJson}\n` +
      `This ensures the subagent returns structured data you can easily parse.`,
    subagents: [
      {
        name: params.subagentName,
        description: `${params.description} Supports response_schema for structured output.`,
        systemPrompt: params.systemPrompt,
        tools: params.tools,
      },
    ],
  });

  const freeTextAgent = createDeepAgent({
    systemPrompt:
      `${params.supervisorContext}\n\n` +
      `You have a subagent called "${params.subagentName}". ` +
      `Use the task tool with subagent_type "${params.subagentName}" to delegate work. ` +
      `Do NOT use the response_schema parameter. Let subagents respond in natural language. ` +
      `Parse whatever text they return to answer the user's question.`,
    subagents: [
      {
        name: params.subagentName,
        description: params.description,
        systemPrompt: params.systemPrompt,
        tools: params.tools,
      },
    ],
  });

  const quickjsAgent = createDeepAgent({
    systemPrompt:
      `${params.supervisorContext}\n\n` +
      `You have a subagent called "${params.subagentName}". ` +
      `You MUST use the js_eval REPL to orchestrate subagent calls — do NOT call the task tool directly.\n\n` +
      `When you need to delegate work to subagents, write a single js_eval call that:\n` +
      `1. Defines the response_schema ONCE as a variable\n` +
      `2. Uses Promise.all to spawn all subagents in parallel\n` +
      `3. Parses the JSON results and logs a summary\n\n` +
      `Example:\n` +
      `\`\`\`typescript\n` +
      `const schema = ${params.dynamicSchemaJson};\n` +
      `const items = ["item1", "item2"];\n` +
      `const results = await Promise.all(\n` +
      `  items.map(item => tools.task({\n` +
      `    description: \`Analyze \${item}\`,\n` +
      `    subagent_type: "${params.subagentName}",\n` +
      `    response_schema: schema,\n` +
      `  }))\n` +
      `);\n` +
      `const parsed = results.map(r => JSON.parse(r));\n` +
      `console.log(JSON.stringify(parsed, null, 2));\n` +
      `\`\`\`\n\n` +
      `After receiving the js_eval output, analyze the data and answer the user's questions.`,
    subagents: [
      {
        name: params.subagentName,
        description: `${params.description} Supports response_schema for structured output.`,
        systemPrompt: params.systemPrompt,
        tools: params.tools,
      },
    ],
    middleware: [
      createQuickJSMiddleware({ ptc: ["task"] }),
    ],
  });

  return { staticAgent, dynamicAgent, freeTextAgent, quickjsAgent };
}

// ---------------------------------------------------------------------------
// Eval queries
// ---------------------------------------------------------------------------

const EVAL_A_QUERY =
  "Research all 8 cities (Tokyo, Seoul, London, Paris, Mumbai, São Paulo, Sydney, Singapore) and tell me: " +
  "which city has the highest population density (population divided by area in sq km)? " +
  "What timezone is that city in? " +
  "What is the exact GDP of the city with the lowest population?";

const EVAL_B_QUERY =
  "Search for flights from NYC to London, Paris, and Tokyo. " +
  "Find the single cheapest flight across all three destinations. " +
  "Then check hotel availability in that cheapest flight's destination city " +
  "and recommend the highest-rated available hotel.";

const EVAL_C_QUERY =
  "Evaluate all 4 candidates: Candidate A, Candidate B, Candidate C, and Candidate D. " +
  "Apply these rules in order: " +
  "(1) Disqualify any candidate with risk_level 'high'. " +
  "(2) Among remaining candidates, the one with the highest score wins. " +
  "(3) If there is a tie on score, the candidate with the lower cost wins. " +
  "(4) If still tied, the candidate with the shorter time_to_completion wins. " +
  "Which candidate wins? Cite the specific numbers that led to your decision.";

// ---------------------------------------------------------------------------
// Eval A: Scale + context pressure
// ---------------------------------------------------------------------------

const evalAAgents = createEvalAgents({
  subagentName: "city_researcher",
  description:
    "Researches comprehensive data about a city using the get_city_data tool. Returns population, GDP, area, timezone, and more.",
  systemPrompt:
    "You are a city research agent. When given a city name, use the get_city_data tool to retrieve its data and report back.",
  tools: [getCityData],
  schema: citySchema,
  supervisorContext:
    "You are a research supervisor. The user will ask questions about cities. " +
    "Delegate each city lookup to your city_researcher subagent in parallel (one task call per city). " +
    "After receiving all results, analyse the data and answer the user's questions with specific numbers.",
  dynamicSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      city: { type: "string" },
      population: { type: "number" },
      gdp: { type: "number" },
      area_sq_km: { type: "number" },
      timezone: { type: "string" },
      mayor: { type: "string" },
      founded_year: { type: "number" },
      elevation: { type: "number" },
      avg_temperature: { type: "number" },
      primary_industry: { type: "string" },
      description: { type: "string" },
      notable_landmarks: { type: "string" },
    },
    required: [
      "city", "population", "gdp", "area_sq_km", "timezone", "mayor",
      "founded_year", "elevation", "avg_temperature", "primary_industry",
      "description", "notable_landmarks",
    ],
  }),
});

ls.describe("structured-output-eval-A-static", () => {
  ls.test(
    "scale: 8 cities with static responseFormat",
    { inputs: { query: EVAL_A_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalAAgents.staticAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Mumbai", true);
      expect(result).toHaveFinalTextContaining("Asia/Kolkata", true);
      expect(result).toHaveFinalTextContaining("770", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-A-dynamic", () => {
  ls.test(
    "scale: 8 cities with dynamic response_schema",
    { inputs: { query: EVAL_A_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalAAgents.dynamicAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Mumbai", true);
      expect(result).toHaveFinalTextContaining("Asia/Kolkata", true);
      expect(result).toHaveFinalTextContaining("770", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-A-freetext", () => {
  ls.test(
    "scale: 8 cities with free text",
    { inputs: { query: EVAL_A_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalAAgents.freeTextAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Mumbai", true);
      expect(result).toHaveFinalTextContaining("Asia/Kolkata", true);
      expect(result).toHaveFinalTextContaining("770", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-A-quickjs", () => {
  ls.test(
    "scale: 8 cities with QuickJS REPL + PTC",
    { inputs: { query: EVAL_A_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalAAgents.quickjsAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Mumbai", true);
      expect(result).toHaveFinalTextContaining("Asia/Kolkata", true);
      expect(result).toHaveFinalTextContaining("770", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

// ---------------------------------------------------------------------------
// Eval B: Multi-hop chaining
// ---------------------------------------------------------------------------

const evalBAgents = (() => {
  const baseDescription =
    "A travel agent that can search for flights or check hotel availability using the appropriate tool.";
  const baseSystemPrompt =
    "You are a travel research agent. Use the search_flights tool to find flights or the check_hotels tool to check hotel availability, depending on what is asked.";
  const baseSupervisorContext =
    "You are a travel planning supervisor. The user wants to find the cheapest flight and then the best hotel in that destination. " +
    "First, delegate flight searches in parallel (one task call per destination). " +
    "After receiving flight results, identify the single cheapest flight across all results. " +
    "Then delegate a hotel search in the cheapest flight's destination city. " +
    "Finally, recommend the highest-rated available hotel.";

  const staticAgent = createDeepAgent({
    systemPrompt:
      `${baseSupervisorContext}\n\n` +
      `You have a subagent called "travel_agent". ` +
      `Use the task tool with subagent_type "travel_agent" to delegate work. ` +
      `The subagent has a built-in structured response format for flights — do NOT pass response_schema.`,
    subagents: [
      {
        name: "travel_agent",
        description: baseDescription,
        systemPrompt: baseSystemPrompt,
        tools: [searchFlights, checkHotels],
        responseFormat: toolStrategy(flightSchema),
      },
    ],
  });

  const dynamicAgent = createDeepAgent({
    systemPrompt:
      `${baseSupervisorContext}\n\n` +
      `You have a subagent called "travel_agent". ` +
      `Use the task tool with subagent_type "travel_agent" to delegate work. ` +
      `You MUST include a response_schema parameter in every task call. ` +
      `For flight searches use this schema:\n` +
      `${JSON.stringify({ type: "object", properties: { airline: { type: "string" }, price: { type: "number" }, duration_hours: { type: "number" }, destination_city: { type: "string" } }, required: ["airline", "price", "duration_hours", "destination_city"] })}\n` +
      `For hotel checks use this schema:\n` +
      `${JSON.stringify({ type: "object", properties: { name: { type: "string" }, price_per_night: { type: "number" }, rating: { type: "number" }, availability: { type: "boolean" } }, required: ["name", "price_per_night", "rating", "availability"] })}`,
    subagents: [
      {
        name: "travel_agent",
        description: `${baseDescription} Supports response_schema for structured output.`,
        systemPrompt: baseSystemPrompt,
        tools: [searchFlights, checkHotels],
      },
    ],
  });

  const freeTextAgent = createDeepAgent({
    systemPrompt:
      `${baseSupervisorContext}\n\n` +
      `You have a subagent called "travel_agent". ` +
      `Use the task tool with subagent_type "travel_agent" to delegate work. ` +
      `Do NOT use the response_schema parameter. Let subagents respond in natural language. ` +
      `Parse whatever text they return to answer the user's question.`,
    subagents: [
      {
        name: "travel_agent",
        description: baseDescription,
        systemPrompt: baseSystemPrompt,
        tools: [searchFlights, checkHotels],
      },
    ],
  });

  const flightSchemaJson = JSON.stringify({ type: "object", properties: { airline: { type: "string" }, price: { type: "number" }, duration_hours: { type: "number" }, destination_city: { type: "string" } }, required: ["airline", "price", "duration_hours", "destination_city"] });
  const hotelSchemaJson = JSON.stringify({ type: "object", properties: { name: { type: "string" }, price_per_night: { type: "number" }, rating: { type: "number" }, availability: { type: "boolean" } }, required: ["name", "price_per_night", "rating", "availability"] });

  const quickjsAgent = createDeepAgent({
    systemPrompt:
      `${baseSupervisorContext}\n\n` +
      `You have a subagent called "travel_agent". ` +
      `You MUST use the js_eval REPL to orchestrate subagent calls — do NOT call the task tool directly.\n\n` +
      `When you need to delegate work to subagents, write a single js_eval call that:\n` +
      `1. Defines the response_schema ONCE as a variable\n` +
      `2. Uses Promise.all to spawn all subagents in parallel\n` +
      `3. Parses the JSON results and logs a summary\n\n` +
      `For flight searches use this schema: ${flightSchemaJson}\n` +
      `For hotel checks use this schema: ${hotelSchemaJson}\n\n` +
      `Example for parallel flight search:\n` +
      `\`\`\`typescript\n` +
      `const flightSchema = ${flightSchemaJson};\n` +
      `const destinations = ["London", "Paris", "Tokyo"];\n` +
      `const results = await Promise.all(\n` +
      `  destinations.map(dest => tools.task({\n` +
      `    description: \`Search flights from NYC to \${dest}\`,\n` +
      `    subagent_type: "travel_agent",\n` +
      `    response_schema: flightSchema,\n` +
      `  }))\n` +
      `);\n` +
      `const parsed = results.map(r => JSON.parse(r));\n` +
      `console.log(JSON.stringify(parsed, null, 2));\n` +
      `\`\`\`\n\n` +
      `After receiving js_eval output, analyze the data and answer the user's questions.`,
    subagents: [
      {
        name: "travel_agent",
        description: `${baseDescription} Supports response_schema for structured output.`,
        systemPrompt: baseSystemPrompt,
        tools: [searchFlights, checkHotels],
      },
    ],
    middleware: [
      createQuickJSMiddleware({ ptc: ["task"] }),
    ],
  });

  return { staticAgent, dynamicAgent, freeTextAgent, quickjsAgent };
})();

ls.describe("structured-output-eval-B-static", () => {
  ls.test(
    "multi-hop: flights then hotels with static responseFormat",
    { inputs: { query: EVAL_B_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalBAgents.staticAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Paris", true);
      expect(result).toHaveFinalTextContaining("Plaza", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-B-dynamic", () => {
  ls.test(
    "multi-hop: flights then hotels with dynamic response_schema",
    { inputs: { query: EVAL_B_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalBAgents.dynamicAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Paris", true);
      expect(result).toHaveFinalTextContaining("Plaza", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-B-freetext", () => {
  ls.test(
    "multi-hop: flights then hotels with free text",
    { inputs: { query: EVAL_B_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalBAgents.freeTextAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Paris", true);
      expect(result).toHaveFinalTextContaining("Plaza", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-B-quickjs", () => {
  ls.test(
    "multi-hop: flights then hotels with QuickJS REPL + PTC",
    { inputs: { query: EVAL_B_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalBAgents.quickjsAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Paris", true);
      expect(result).toHaveFinalTextContaining("Plaza", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

// ---------------------------------------------------------------------------
// Eval C: Conditional logic
// ---------------------------------------------------------------------------

const evalCAgents = createEvalAgents({
  subagentName: "evaluator",
  description:
    "Evaluates a candidate by name using the evaluate_candidate tool. Returns their score, risk, time, cost, and specialty.",
  systemPrompt:
    "You are a candidate evaluation agent. When given a candidate name, use the evaluate_candidate tool and report the results.",
  tools: [evaluateCandidate],
  schema: candidateSchema,
  supervisorContext:
    "You are a hiring supervisor. The user will ask you to evaluate candidates and pick the winner based on specific rules. " +
    "Delegate each candidate evaluation to your evaluator subagent in parallel (one task call per candidate). " +
    "After receiving all results, apply the user's rules precisely and cite specific numbers in your final answer.",
  dynamicSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      name: { type: "string" },
      score: { type: "number" },
      risk_level: { type: "string" },
      time_to_completion: { type: "number" },
      cost: { type: "number" },
      specialty: { type: "string" },
    },
    required: ["name", "score", "risk_level", "time_to_completion", "cost", "specialty"],
  }),
});

ls.describe("structured-output-eval-C-static", () => {
  ls.test(
    "conditional: candidate selection with static responseFormat",
    { inputs: { query: EVAL_C_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalCAgents.staticAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Candidate B", true);
      expect(result).toHaveFinalTextContaining("4,500", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-C-dynamic", () => {
  ls.test(
    "conditional: candidate selection with dynamic response_schema",
    { inputs: { query: EVAL_C_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalCAgents.dynamicAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Candidate B", true);
      expect(result).toHaveFinalTextContaining("4,500", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-C-freetext", () => {
  ls.test(
    "conditional: candidate selection with free text",
    { inputs: { query: EVAL_C_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalCAgents.freeTextAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Candidate B", true);
      expect(result).toHaveFinalTextContaining("4,500", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-C-quickjs", () => {
  ls.test(
    "conditional: candidate selection with QuickJS REPL + PTC",
    { inputs: { query: EVAL_C_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalCAgents.quickjsAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Candidate B", true);
      expect(result).toHaveFinalTextContaining("4,500", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

// ---------------------------------------------------------------------------
// Eval D: Noisy cross-reference stress test
//
// 8 "sector analyst" subagents each return a report covering 5 companies.
// Tool output is ~600 tokens of deliberately noisy prose per sector:
// distractor numbers, hedging, historical comparisons, multiple metrics.
// The query requires computing revenue-per-employee across all 40 companies,
// plus a conditional filter on risk score.
// ---------------------------------------------------------------------------

interface CompanyData {
  name: string;
  revenue: number;
  prev_year_revenue: number;
  employees: number;
  contractors: number;
  growth_rate_annual: number;
  growth_rate_quarterly: number;
  market_cap: number;
  enterprise_value: number;
  risk_score: number;
}

interface SectorData {
  sector: string;
  companies: CompanyData[];
}

// Ground truth:
// Revenue/employee top 2:
//   NovaPharma: 4,200,000,000 / 8,200 = 512,195  <-- WINNER
//   StratoCloud: 5,100,000,000 / 10,100 = 504,950
//
// Risk > 8.0:
//   IronForge Global (8.4, market_cap $48B)
//   DeepCurrentAI (8.7, market_cap $58B)
//   AquaPure Systems (8.1, market_cap $3.1B)  <-- lowest cap

const SECTOR_DATABASE: Record<string, SectorData> = {
  Technology: {
    sector: "Technology",
    companies: [
      { name: "QuantumLeap Systems", revenue: 3_800_000_000, prev_year_revenue: 3_400_000_000, employees: 14200, contractors: 3100, growth_rate_annual: 11.8, growth_rate_quarterly: 3.2, market_cap: 42_000_000_000, enterprise_value: 45_500_000_000, risk_score: 5.2 },
      { name: "ByteForge Inc", revenue: 2_100_000_000, prev_year_revenue: 1_950_000_000, employees: 8900, contractors: 2200, growth_rate_annual: 7.7, growth_rate_quarterly: 1.8, market_cap: 18_000_000_000, enterprise_value: 19_200_000_000, risk_score: 4.1 },
      { name: "NeuralPath Corp", revenue: 5_600_000_000, prev_year_revenue: 5_100_000_000, employees: 22000, contractors: 5500, growth_rate_annual: 9.8, growth_rate_quarterly: 2.6, market_cap: 67_000_000_000, enterprise_value: 71_000_000_000, risk_score: 3.8 },
      { name: "CipherDyn", revenue: 890_000_000, prev_year_revenue: 820_000_000, employees: 3400, contractors: 800, growth_rate_annual: 8.5, growth_rate_quarterly: 2.1, market_cap: 7_200_000_000, enterprise_value: 7_800_000_000, risk_score: 6.3 },
      { name: "VoltGrid Tech", revenue: 1_450_000_000, prev_year_revenue: 1_380_000_000, employees: 6100, contractors: 1400, growth_rate_annual: 5.1, growth_rate_quarterly: 1.3, market_cap: 12_500_000_000, enterprise_value: 13_100_000_000, risk_score: 4.7 },
    ],
  },
  Healthcare: {
    sector: "Healthcare",
    companies: [
      { name: "NovaPharma", revenue: 4_200_000_000, prev_year_revenue: 3_750_000_000, employees: 8200, contractors: 2100, growth_rate_annual: 12.0, growth_rate_quarterly: 3.4, market_cap: 52_000_000_000, enterprise_value: 55_000_000_000, risk_score: 5.9 },
      { name: "MediSync Global", revenue: 2_800_000_000, prev_year_revenue: 2_600_000_000, employees: 11500, contractors: 3200, growth_rate_annual: 7.7, growth_rate_quarterly: 1.9, market_cap: 28_000_000_000, enterprise_value: 30_500_000_000, risk_score: 4.5 },
      { name: "BioVantage Labs", revenue: 1_600_000_000, prev_year_revenue: 1_480_000_000, employees: 6700, contractors: 1800, growth_rate_annual: 8.1, growth_rate_quarterly: 2.0, market_cap: 19_000_000_000, enterprise_value: 20_200_000_000, risk_score: 7.2 },
      { name: "HelixCure", revenue: 950_000_000, prev_year_revenue: 870_000_000, employees: 4100, contractors: 950, growth_rate_annual: 9.2, growth_rate_quarterly: 2.5, market_cap: 11_000_000_000, enterprise_value: 11_800_000_000, risk_score: 6.8 },
      { name: "PulsePoint Diagnostics", revenue: 3_100_000_000, prev_year_revenue: 2_900_000_000, employees: 13200, contractors: 2800, growth_rate_annual: 6.9, growth_rate_quarterly: 1.7, market_cap: 35_000_000_000, enterprise_value: 37_000_000_000, risk_score: 3.4 },
    ],
  },
  Cloud: {
    sector: "Cloud Infrastructure",
    companies: [
      { name: "StratoCloud", revenue: 5_100_000_000, prev_year_revenue: 4_500_000_000, employees: 10100, contractors: 4200, growth_rate_annual: 13.3, growth_rate_quarterly: 3.6, market_cap: 78_000_000_000, enterprise_value: 82_000_000_000, risk_score: 4.9 },
      { name: "NimbusScale", revenue: 2_300_000_000, prev_year_revenue: 2_050_000_000, employees: 7800, contractors: 2100, growth_rate_annual: 12.2, growth_rate_quarterly: 3.1, market_cap: 31_000_000_000, enterprise_value: 33_000_000_000, risk_score: 5.5 },
      { name: "EdgeVault", revenue: 1_700_000_000, prev_year_revenue: 1_550_000_000, employees: 5400, contractors: 1300, growth_rate_annual: 9.7, growth_rate_quarterly: 2.4, market_cap: 20_000_000_000, enterprise_value: 21_500_000_000, risk_score: 6.1 },
      { name: "TerraNode Systems", revenue: 3_400_000_000, prev_year_revenue: 3_100_000_000, employees: 12800, contractors: 3500, growth_rate_annual: 9.7, growth_rate_quarterly: 2.5, market_cap: 41_000_000_000, enterprise_value: 44_000_000_000, risk_score: 4.2 },
      { name: "FluxLayer", revenue: 780_000_000, prev_year_revenue: 690_000_000, employees: 2900, contractors: 700, growth_rate_annual: 13.0, growth_rate_quarterly: 3.5, market_cap: 9_500_000_000, enterprise_value: 10_100_000_000, risk_score: 7.8 },
    ],
  },
  Energy: {
    sector: "Energy",
    companies: [
      { name: "SolarPeak", revenue: 2_900_000_000, prev_year_revenue: 2_600_000_000, employees: 9500, contractors: 4100, growth_rate_annual: 11.5, growth_rate_quarterly: 3.0, market_cap: 33_000_000_000, enterprise_value: 36_000_000_000, risk_score: 5.7 },
      { name: "FusionDrive Energy", revenue: 4_800_000_000, prev_year_revenue: 4_400_000_000, employees: 18000, contractors: 6200, growth_rate_annual: 9.1, growth_rate_quarterly: 2.3, market_cap: 55_000_000_000, enterprise_value: 59_000_000_000, risk_score: 4.3 },
      { name: "WindCrest Power", revenue: 1_200_000_000, prev_year_revenue: 1_100_000_000, employees: 5200, contractors: 1800, growth_rate_annual: 9.1, growth_rate_quarterly: 2.2, market_cap: 14_000_000_000, enterprise_value: 15_200_000_000, risk_score: 6.5 },
      { name: "AtomicHorizon", revenue: 6_200_000_000, prev_year_revenue: 5_800_000_000, employees: 25000, contractors: 7500, growth_rate_annual: 6.9, growth_rate_quarterly: 1.7, market_cap: 71_000_000_000, enterprise_value: 76_000_000_000, risk_score: 7.1 },
      { name: "GreenArc Solutions", revenue: 850_000_000, prev_year_revenue: 780_000_000, employees: 3600, contractors: 900, growth_rate_annual: 9.0, growth_rate_quarterly: 2.3, market_cap: 8_200_000_000, enterprise_value: 8_900_000_000, risk_score: 5.0 },
    ],
  },
  Mining: {
    sector: "Mining & Materials",
    companies: [
      { name: "IronForge Global", revenue: 7_100_000_000, prev_year_revenue: 6_500_000_000, employees: 32000, contractors: 11000, growth_rate_annual: 9.2, growth_rate_quarterly: 2.4, market_cap: 48_000_000_000, enterprise_value: 53_000_000_000, risk_score: 8.4 },
      { name: "CobaltRidge", revenue: 2_400_000_000, prev_year_revenue: 2_200_000_000, employees: 9800, contractors: 3400, growth_rate_annual: 9.1, growth_rate_quarterly: 2.2, market_cap: 22_000_000_000, enterprise_value: 24_000_000_000, risk_score: 7.6 },
      { name: "TitanCore Minerals", revenue: 3_600_000_000, prev_year_revenue: 3_300_000_000, employees: 14500, contractors: 5200, growth_rate_annual: 9.1, growth_rate_quarterly: 2.3, market_cap: 37_000_000_000, enterprise_value: 40_000_000_000, risk_score: 6.9 },
      { name: "RareEarth Dynamics", revenue: 1_100_000_000, prev_year_revenue: 980_000_000, employees: 4800, contractors: 1500, growth_rate_annual: 12.2, growth_rate_quarterly: 3.2, market_cap: 13_000_000_000, enterprise_value: 14_000_000_000, risk_score: 7.3 },
      { name: "SilverVein Corp", revenue: 1_800_000_000, prev_year_revenue: 1_700_000_000, employees: 7600, contractors: 2800, growth_rate_annual: 5.9, growth_rate_quarterly: 1.4, market_cap: 16_000_000_000, enterprise_value: 17_500_000_000, risk_score: 5.8 },
    ],
  },
  AI: {
    sector: "Artificial Intelligence",
    companies: [
      { name: "DeepCurrentAI", revenue: 3_200_000_000, prev_year_revenue: 2_700_000_000, employees: 6800, contractors: 2400, growth_rate_annual: 18.5, growth_rate_quarterly: 5.1, market_cap: 58_000_000_000, enterprise_value: 61_000_000_000, risk_score: 8.7 },
      { name: "SynapticWave", revenue: 1_900_000_000, prev_year_revenue: 1_600_000_000, employees: 5200, contractors: 1800, growth_rate_annual: 18.8, growth_rate_quarterly: 5.0, market_cap: 34_000_000_000, enterprise_value: 36_000_000_000, risk_score: 7.4 },
      { name: "CortexAI Labs", revenue: 750_000_000, prev_year_revenue: 580_000_000, employees: 2100, contractors: 800, growth_rate_annual: 29.3, growth_rate_quarterly: 7.8, market_cap: 21_000_000_000, enterprise_value: 22_000_000_000, risk_score: 7.9 },
      { name: "LogicMesh", revenue: 2_600_000_000, prev_year_revenue: 2_300_000_000, employees: 9400, contractors: 3100, growth_rate_annual: 13.0, growth_rate_quarterly: 3.4, market_cap: 39_000_000_000, enterprise_value: 41_500_000_000, risk_score: 5.6 },
      { name: "PerceptronX", revenue: 1_300_000_000, prev_year_revenue: 1_100_000_000, employees: 4500, contractors: 1200, growth_rate_annual: 18.2, growth_rate_quarterly: 4.8, market_cap: 25_000_000_000, enterprise_value: 26_500_000_000, risk_score: 6.8 },
    ],
  },
  Water: {
    sector: "Water & Utilities",
    companies: [
      { name: "AquaPure Systems", revenue: 1_500_000_000, prev_year_revenue: 1_400_000_000, employees: 7200, contractors: 2500, growth_rate_annual: 7.1, growth_rate_quarterly: 1.8, market_cap: 3_100_000_000, enterprise_value: 3_800_000_000, risk_score: 8.1 },
      { name: "HydroVolt", revenue: 2_200_000_000, prev_year_revenue: 2_050_000_000, employees: 9100, contractors: 3000, growth_rate_annual: 7.3, growth_rate_quarterly: 1.9, market_cap: 11_500_000_000, enterprise_value: 12_800_000_000, risk_score: 4.8 },
      { name: "ClearStream Global", revenue: 3_800_000_000, prev_year_revenue: 3_500_000_000, employees: 15800, contractors: 4200, growth_rate_annual: 8.6, growth_rate_quarterly: 2.1, market_cap: 27_000_000_000, enterprise_value: 29_500_000_000, risk_score: 3.9 },
      { name: "TidalForce", revenue: 900_000_000, prev_year_revenue: 830_000_000, employees: 3800, contractors: 1100, growth_rate_annual: 8.4, growth_rate_quarterly: 2.1, market_cap: 7_800_000_000, enterprise_value: 8_400_000_000, risk_score: 5.3 },
      { name: "ReservoirTech", revenue: 1_700_000_000, prev_year_revenue: 1_580_000_000, employees: 6900, contractors: 2000, growth_rate_annual: 7.6, growth_rate_quarterly: 1.9, market_cap: 14_000_000_000, enterprise_value: 15_200_000_000, risk_score: 4.1 },
    ],
  },
  Fintech: {
    sector: "Financial Technology",
    companies: [
      { name: "LedgerPrime", revenue: 2_700_000_000, prev_year_revenue: 2_400_000_000, employees: 5800, contractors: 2000, growth_rate_annual: 12.5, growth_rate_quarterly: 3.3, market_cap: 44_000_000_000, enterprise_value: 46_500_000_000, risk_score: 6.2 },
      { name: "PayCircuit", revenue: 4_500_000_000, prev_year_revenue: 4_100_000_000, employees: 16000, contractors: 4500, growth_rate_annual: 9.8, growth_rate_quarterly: 2.5, market_cap: 62_000_000_000, enterprise_value: 65_000_000_000, risk_score: 4.0 },
      { name: "CoinVault Exchange", revenue: 1_800_000_000, prev_year_revenue: 1_500_000_000, employees: 4200, contractors: 1300, growth_rate_annual: 20.0, growth_rate_quarterly: 5.4, market_cap: 29_000_000_000, enterprise_value: 30_500_000_000, risk_score: 7.5 },
      { name: "InsurTech Nexus", revenue: 1_100_000_000, prev_year_revenue: 1_000_000_000, employees: 4900, contractors: 1100, growth_rate_annual: 10.0, growth_rate_quarterly: 2.6, market_cap: 15_000_000_000, enterprise_value: 16_000_000_000, risk_score: 5.1 },
      { name: "WealthGrid", revenue: 3_300_000_000, prev_year_revenue: 3_000_000_000, employees: 11200, contractors: 3200, growth_rate_annual: 10.0, growth_rate_quarterly: 2.6, market_cap: 40_000_000_000, enterprise_value: 42_500_000_000, risk_score: 4.4 },
    ],
  },
};

function generateNoisyReport(sector: SectorData): string {
  const lines: string[] = [
    `SECTOR ANALYSIS REPORT: ${sector.sector.toUpperCase()}`,
    ``,
    `This comprehensive quarterly review covers the ${sector.sector} sector, which has experienced varied performance across its constituent companies. ` +
    `The following assessments are based on a combination of audited financial statements, independent analyst estimates, and proprietary risk modelling. ` +
    `Note that figures may differ slightly from other published sources due to methodological differences in revenue recognition and employee classification. ` +
    `All monetary values are in USD unless otherwise stated.`,
    ``,
  ];

  for (const c of sector.companies) {
    const revBillions = (c.revenue / 1_000_000_000).toFixed(1);
    const prevBillions = (c.prev_year_revenue / 1_000_000_000).toFixed(1);
    const capBillions = (c.market_cap / 1_000_000_000).toFixed(1);
    const evBillions = (c.enterprise_value / 1_000_000_000).toFixed(1);
    const totalWorkforce = c.employees + c.contractors;

    lines.push(
      `--- ${c.name} ---`,
      ``,
      `${c.name} reported annual revenue of approximately $${revBillions} billion for the most recent fiscal year, ` +
      `representing an increase from the prior year figure of $${prevBillions} billion. It should be noted that some analysts ` +
      `have cited a slightly higher revenue estimate of $${(c.revenue * 1.02 / 1_000_000_000).toFixed(1)} billion when including deferred revenue adjustments, ` +
      `though the audited figure remains $${(c.revenue / 1_000_000_000).toFixed(2)} billion. The company's annual growth rate stands at ${c.growth_rate_annual}%, ` +
      `while the most recent quarterly growth rate was recorded at ${c.growth_rate_quarterly}% — investors should be careful not to annualise ` +
      `the quarterly figure as seasonal effects can distort the picture. Historical five-year CAGR is estimated at roughly ${(c.growth_rate_annual * 0.85).toFixed(1)}%.`,
      ``,
      `The company currently employs ${c.employees.toLocaleString()} full-time staff members, with an additional ${c.contractors.toLocaleString()} contractors and temporary workers ` +
      `bringing the total workforce to approximately ${totalWorkforce.toLocaleString()} individuals. The previous year's headcount was roughly ${Math.round(c.employees * 0.95).toLocaleString()} ` +
      `full-time equivalents. When evaluating productivity metrics, analysts should use the full-time employee count of ${c.employees.toLocaleString()} rather than ` +
      `the total workforce figure, as contractor arrangements vary significantly across reporting periods.`,
      ``,
      `Market capitalisation is valued at $${capBillions} billion as of the most recent trading close, while enterprise value ` +
      `(which accounts for debt and cash positions) sits at $${evBillions} billion. The enterprise-value-to-revenue multiple is ` +
      `approximately ${(c.enterprise_value / c.revenue).toFixed(1)}x. Some valuation models using discounted cash flow analysis suggest a fair value closer to ` +
      `$${(c.market_cap * 0.92 / 1_000_000_000).toFixed(1)} billion, representing a potential ${((1 - 0.92) * 100).toFixed(0)}% overvaluation at current prices.`,
      ``,
      `Risk assessment: The composite risk score for ${c.name} is ${c.risk_score} on our proprietary 1-10 scale ` +
      `(where 10 represents maximum risk). This incorporates regulatory exposure, market concentration, debt-to-equity ratios, ` +
      `and management stability factors. The sector average risk score is approximately ${(sector.companies.reduce((s, x) => s + x.risk_score, 0) / sector.companies.length).toFixed(1)}.`,
      ``,
    );
  }

  lines.push(
    `END OF ${sector.sector.toUpperCase()} SECTOR REPORT. All figures are estimates and should not be relied upon for investment decisions without independent verification.`,
  );

  return lines.join("\n");
}

const analyzeSector = tool(
  async (input) => {
    const sectorKey = Object.keys(SECTOR_DATABASE).find(
      (k) =>
        k.toLowerCase() === input.sector.toLowerCase() ||
        SECTOR_DATABASE[k].sector.toLowerCase() ===
          input.sector.toLowerCase(),
    );
    if (!sectorKey) return `No data found for sector: ${input.sector}`;
    return generateNoisyReport(SECTOR_DATABASE[sectorKey]);
  },
  {
    name: "analyze_sector",
    description:
      "Retrieve a detailed analyst report for a market sector, covering 5 companies with revenue, employees, growth, market cap, and risk data.",
    schema: z.object({
      sector: z
        .string()
        .describe(
          "Sector name (e.g. 'Technology', 'Healthcare', 'Cloud', 'Energy', 'Mining', 'AI', 'Water', 'Fintech')",
        ),
    }),
  },
);

const sectorCompanySchema = z.object({
  companies: z
    .array(
      z.object({
        name: z.string().describe("Company name"),
        revenue: z.number().describe("Annual revenue in USD"),
        employees: z
          .number()
          .describe("Full-time employee count (not contractors)"),
        growth_rate_annual: z
          .number()
          .describe("Annual growth rate percentage"),
        market_cap: z.number().describe("Market capitalisation in USD"),
        risk_score: z.number().describe("Risk score on 1-10 scale"),
      }),
    )
    .describe("Array of companies in this sector"),
});

const EVAL_D_QUERY =
  "Analyze all 8 sectors: Technology, Healthcare, Cloud, Energy, Mining, AI, Water, and Fintech. " +
  "For each sector's companies, use the full-time employee count (NOT total workforce including contractors). " +
  "Then answer these questions:\n" +
  "1. Across all 40 companies, which single company has the highest revenue-per-employee ratio? " +
  "Give the company name and the exact ratio.\n" +
  "2. List every company with a risk score strictly above 8.0. " +
  "Among those high-risk companies, which one has the lowest market capitalisation? " +
  "Give the company name and its exact market cap.";

const evalDAgents = createEvalAgents({
  subagentName: "sector_analyst",
  description:
    "Analyzes a market sector using the analyze_sector tool. Returns data on 5 companies including revenue, employees, growth, market cap, and risk scores.",
  systemPrompt:
    "You are a sector analysis agent. When given a sector name, use the analyze_sector tool to retrieve the report and extract the data for each company. " +
    "Pay careful attention to distinguish between full-time employees and total workforce (which includes contractors). " +
    "Use the audited revenue figure, not adjusted estimates.",
  tools: [analyzeSector],
  schema: sectorCompanySchema,
  supervisorContext:
    "You are a market research supervisor. The user will ask questions requiring analysis across multiple market sectors. " +
    "Delegate each sector analysis to your sector_analyst subagent in parallel (one task call per sector). " +
    "After receiving all results, compute the requested metrics precisely using exact numbers. " +
    "Revenue-per-employee means dividing annual revenue by full-time employee count. " +
    "Show your work with specific numbers when answering.",
  dynamicSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      companies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            revenue: { type: "number" },
            employees: { type: "number" },
            growth_rate_annual: { type: "number" },
            market_cap: { type: "number" },
            risk_score: { type: "number" },
          },
          required: [
            "name",
            "revenue",
            "employees",
            "growth_rate_annual",
            "market_cap",
            "risk_score",
          ],
        },
      },
    },
    required: ["companies"],
  }),
});

ls.describe("structured-output-eval-D-static", () => {
  ls.test(
    "stress: 40 companies noisy cross-reference with static responseFormat",
    { inputs: { query: EVAL_D_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalDAgents.staticAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("NovaPharma", true);
      expect(result).toHaveFinalTextContaining("AquaPure", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-D-dynamic", () => {
  ls.test(
    "stress: 40 companies noisy cross-reference with dynamic response_schema",
    { inputs: { query: EVAL_D_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalDAgents.dynamicAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("NovaPharma", true);
      expect(result).toHaveFinalTextContaining("AquaPure", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-D-freetext", () => {
  ls.test(
    "stress: 40 companies noisy cross-reference with free text",
    { inputs: { query: EVAL_D_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalDAgents.freeTextAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("NovaPharma", true);
      expect(result).toHaveFinalTextContaining("AquaPure", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-D-quickjs", () => {
  ls.test(
    "stress: 40 companies noisy cross-reference with QuickJS REPL + PTC",
    { inputs: { query: EVAL_D_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalDAgents.quickjsAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("NovaPharma", true);
      expect(result).toHaveFinalTextContaining("AquaPure", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

// ---------------------------------------------------------------------------
// Eval E: Extreme stress test
//
// 12 "regional analyst" subagents, each returning a wall-of-text report
// covering 8 suppliers. NO headers, NO bullet points — just dense running
// prose with contradictory sources, multiple versions of every number,
// historical data interleaved with current data, and near-identical values
// across suppliers designed to make extraction extremely error-prone.
//
// Total: 96 entities across 12 regions, ~2000+ tokens per report.
//
// Query requires:
//   1. Find the supplier with the highest unit output across all 96
//   2. Compute defect-rate-per-unit (defects / units) for each, find lowest
//   3. List all suppliers with lead_time > 45 days AND cost > $150/unit
//      Among those, find the one with the highest quality_score
//
// Ground truth is carefully designed with near-ties requiring exact numbers.
// ---------------------------------------------------------------------------

interface SupplierData {
  name: string;
  units_produced: number;
  units_reported_by_trade_journal: number;
  defects: number;
  defects_prior_year: number;
  cost_per_unit: number;
  cost_per_unit_competitor_estimate: number;
  lead_time_days: number;
  lead_time_days_last_quarter: number;
  quality_score: number;
  quality_score_industry_avg: number;
  workforce: number;
  temp_workers: number;
  capacity_utilization: number;
  year_established: number;
}

interface RegionData {
  region: string;
  suppliers: SupplierData[];
}

// Ground truth designed for maximum confusion:
//
// 1. Highest units_produced: "Pacifica Alloys" in Oceania at 487,200
//    Close runner-up: "Nordic Forge" in Scandinavia at 486,800
//    Trap: Pacifica's trade journal figure is 489,000 (wrong number to use)
//
// 2. Lowest defect-rate-per-unit (defects/units_produced):
//    "Helvetia Precision" in Alps: 112 / 385,000 = 0.0002909...
//    Close runner-up: "Rhine Components" in Western Europe: 98 / 334,500 = 0.0002929...
//    Trap: Helvetia's prior year defects were 89 (lower, but wrong year)
//
// 3. lead_time > 45 AND cost > $150:
//    "Ural Heavy Industries" (lead 52, cost $178, quality 7.1)
//    "Gobi Materials" (lead 48, cost $162, quality 8.3)  <-- highest quality
//    "Patagonia Steel" (lead 51, cost $155, quality 6.9)
//    "Saharan Metals" (lead 47, cost $171, quality 7.8)
//    Answer: Gobi Materials (quality 8.3)

const REGION_DATABASE: Record<string, RegionData> = {
  "East Asia": {
    region: "East Asia",
    suppliers: [
      { name: "Yangtze Manufacturing", units_produced: 412_300, units_reported_by_trade_journal: 415_000, defects: 287, defects_prior_year: 312, cost_per_unit: 89, cost_per_unit_competitor_estimate: 92, lead_time_days: 21, lead_time_days_last_quarter: 23, quality_score: 8.7, quality_score_industry_avg: 7.9, workforce: 4200, temp_workers: 1100, capacity_utilization: 87.3, year_established: 1994 },
      { name: "Shenzhen Dynamics", units_produced: 378_500, units_reported_by_trade_journal: 380_200, defects: 198, defects_prior_year: 221, cost_per_unit: 76, cost_per_unit_competitor_estimate: 79, lead_time_days: 18, lead_time_days_last_quarter: 19, quality_score: 9.1, quality_score_industry_avg: 7.9, workforce: 3800, temp_workers: 900, capacity_utilization: 91.2, year_established: 2001 },
      { name: "Osaka Precision Works", units_produced: 295_800, units_reported_by_trade_journal: 298_000, defects: 134, defects_prior_year: 142, cost_per_unit: 142, cost_per_unit_competitor_estimate: 138, lead_time_days: 28, lead_time_days_last_quarter: 30, quality_score: 9.4, quality_score_industry_avg: 7.9, workforce: 2100, temp_workers: 350, capacity_utilization: 78.6, year_established: 1967 },
      { name: "Seoul Components Ltd", units_produced: 341_200, units_reported_by_trade_journal: 343_500, defects: 245, defects_prior_year: 267, cost_per_unit: 98, cost_per_unit_competitor_estimate: 101, lead_time_days: 24, lead_time_days_last_quarter: 26, quality_score: 8.2, quality_score_industry_avg: 7.9, workforce: 2900, temp_workers: 650, capacity_utilization: 82.1, year_established: 1988 },
      { name: "Taipei MicroFab", units_produced: 267_400, units_reported_by_trade_journal: 269_100, defects: 156, defects_prior_year: 173, cost_per_unit: 118, cost_per_unit_competitor_estimate: 115, lead_time_days: 22, lead_time_days_last_quarter: 24, quality_score: 8.9, quality_score_industry_avg: 7.9, workforce: 1800, temp_workers: 420, capacity_utilization: 84.7, year_established: 2005 },
      { name: "Hanoi Industrial Group", units_produced: 198_700, units_reported_by_trade_journal: 201_000, defects: 312, defects_prior_year: 345, cost_per_unit: 62, cost_per_unit_competitor_estimate: 65, lead_time_days: 32, lead_time_days_last_quarter: 35, quality_score: 6.8, quality_score_industry_avg: 7.9, workforce: 5100, temp_workers: 2200, capacity_utilization: 69.4, year_established: 2011 },
      { name: "Manila Metalworks", units_produced: 156_300, units_reported_by_trade_journal: 158_000, defects: 278, defects_prior_year: 301, cost_per_unit: 58, cost_per_unit_competitor_estimate: 61, lead_time_days: 35, lead_time_days_last_quarter: 38, quality_score: 6.2, quality_score_industry_avg: 7.9, workforce: 4800, temp_workers: 2000, capacity_utilization: 65.8, year_established: 2014 },
      { name: "Jakarta Foundry Co", units_produced: 183_900, units_reported_by_trade_journal: 186_000, defects: 267, defects_prior_year: 289, cost_per_unit: 71, cost_per_unit_competitor_estimate: 74, lead_time_days: 29, lead_time_days_last_quarter: 31, quality_score: 7.1, quality_score_industry_avg: 7.9, workforce: 3600, temp_workers: 1400, capacity_utilization: 72.3, year_established: 2008 },
    ],
  },
  "Western Europe": {
    region: "Western Europe",
    suppliers: [
      { name: "Rhine Components", units_produced: 334_500, units_reported_by_trade_journal: 336_800, defects: 98, defects_prior_year: 105, cost_per_unit: 187, cost_per_unit_competitor_estimate: 182, lead_time_days: 31, lead_time_days_last_quarter: 33, quality_score: 9.6, quality_score_industry_avg: 8.4, workforce: 2800, temp_workers: 400, capacity_utilization: 81.5, year_established: 1952 },
      { name: "Loire Fabrication", units_produced: 278_100, units_reported_by_trade_journal: 280_500, defects: 167, defects_prior_year: 178, cost_per_unit: 168, cost_per_unit_competitor_estimate: 164, lead_time_days: 34, lead_time_days_last_quarter: 36, quality_score: 8.8, quality_score_industry_avg: 8.4, workforce: 2200, temp_workers: 380, capacity_utilization: 76.2, year_established: 1971 },
      { name: "Lombardy Castings", units_produced: 312_800, units_reported_by_trade_journal: 315_000, defects: 189, defects_prior_year: 201, cost_per_unit: 145, cost_per_unit_competitor_estimate: 141, lead_time_days: 27, lead_time_days_last_quarter: 29, quality_score: 8.5, quality_score_industry_avg: 8.4, workforce: 2600, temp_workers: 520, capacity_utilization: 83.7, year_established: 1983 },
      { name: "Ruhr Steelworks", units_produced: 398_200, units_reported_by_trade_journal: 401_000, defects: 234, defects_prior_year: 251, cost_per_unit: 132, cost_per_unit_competitor_estimate: 128, lead_time_days: 25, lead_time_days_last_quarter: 27, quality_score: 8.1, quality_score_industry_avg: 8.4, workforce: 3400, temp_workers: 700, capacity_utilization: 88.9, year_established: 1948 },
      { name: "Basque Alloys", units_produced: 245_600, units_reported_by_trade_journal: 247_800, defects: 178, defects_prior_year: 192, cost_per_unit: 156, cost_per_unit_competitor_estimate: 152, lead_time_days: 30, lead_time_days_last_quarter: 32, quality_score: 8.3, quality_score_industry_avg: 8.4, workforce: 1900, temp_workers: 340, capacity_utilization: 74.8, year_established: 1996 },
      { name: "Flanders Precision", units_produced: 221_400, units_reported_by_trade_journal: 223_000, defects: 112, defects_prior_year: 119, cost_per_unit: 198, cost_per_unit_competitor_estimate: 193, lead_time_days: 36, lead_time_days_last_quarter: 38, quality_score: 9.2, quality_score_industry_avg: 8.4, workforce: 1600, temp_workers: 250, capacity_utilization: 71.3, year_established: 1965 },
      { name: "Iberian Metals", units_produced: 189_700, units_reported_by_trade_journal: 191_500, defects: 201, defects_prior_year: 218, cost_per_unit: 112, cost_per_unit_competitor_estimate: 108, lead_time_days: 33, lead_time_days_last_quarter: 35, quality_score: 7.4, quality_score_industry_avg: 8.4, workforce: 2100, temp_workers: 580, capacity_utilization: 68.9, year_established: 2002 },
      { name: "Danube Industries", units_produced: 267_300, units_reported_by_trade_journal: 269_500, defects: 156, defects_prior_year: 167, cost_per_unit: 141, cost_per_unit_competitor_estimate: 137, lead_time_days: 28, lead_time_days_last_quarter: 30, quality_score: 8.6, quality_score_industry_avg: 8.4, workforce: 2400, temp_workers: 460, capacity_utilization: 79.1, year_established: 1978 },
    ],
  },
  "North America": {
    region: "North America",
    suppliers: [
      { name: "Great Lakes Foundry", units_produced: 445_100, units_reported_by_trade_journal: 448_000, defects: 312, defects_prior_year: 334, cost_per_unit: 124, cost_per_unit_competitor_estimate: 120, lead_time_days: 19, lead_time_days_last_quarter: 21, quality_score: 8.4, quality_score_industry_avg: 8.0, workforce: 3900, temp_workers: 850, capacity_utilization: 89.5, year_established: 1956 },
      { name: "Cascadia Materials", units_produced: 312_400, units_reported_by_trade_journal: 314_800, defects: 187, defects_prior_year: 201, cost_per_unit: 138, cost_per_unit_competitor_estimate: 134, lead_time_days: 23, lead_time_days_last_quarter: 25, quality_score: 8.9, quality_score_industry_avg: 8.0, workforce: 2700, temp_workers: 500, capacity_utilization: 82.3, year_established: 1979 },
      { name: "Appalachian Steel", units_produced: 389_700, units_reported_by_trade_journal: 392_000, defects: 267, defects_prior_year: 289, cost_per_unit: 108, cost_per_unit_competitor_estimate: 105, lead_time_days: 21, lead_time_days_last_quarter: 23, quality_score: 7.8, quality_score_industry_avg: 8.0, workforce: 3500, temp_workers: 780, capacity_utilization: 86.1, year_established: 1962 },
      { name: "Sonoran Fabrication", units_produced: 234_800, units_reported_by_trade_journal: 236_500, defects: 178, defects_prior_year: 192, cost_per_unit: 95, cost_per_unit_competitor_estimate: 92, lead_time_days: 26, lead_time_days_last_quarter: 28, quality_score: 7.5, quality_score_industry_avg: 8.0, workforce: 2800, temp_workers: 920, capacity_utilization: 75.4, year_established: 1998 },
      { name: "Prairie Components", units_produced: 278_600, units_reported_by_trade_journal: 280_200, defects: 156, defects_prior_year: 168, cost_per_unit: 119, cost_per_unit_competitor_estimate: 116, lead_time_days: 22, lead_time_days_last_quarter: 24, quality_score: 8.6, quality_score_industry_avg: 8.0, workforce: 2200, temp_workers: 410, capacity_utilization: 80.7, year_established: 1985 },
      { name: "Alberta Precision", units_produced: 198_300, units_reported_by_trade_journal: 200_100, defects: 112, defects_prior_year: 121, cost_per_unit: 167, cost_per_unit_competitor_estimate: 163, lead_time_days: 29, lead_time_days_last_quarter: 31, quality_score: 9.3, quality_score_industry_avg: 8.0, workforce: 1500, temp_workers: 280, capacity_utilization: 73.2, year_established: 1974 },
      { name: "Gulf Coast Metals", units_produced: 356_900, units_reported_by_trade_journal: 359_200, defects: 289, defects_prior_year: 312, cost_per_unit: 102, cost_per_unit_competitor_estimate: 99, lead_time_days: 20, lead_time_days_last_quarter: 22, quality_score: 7.6, quality_score_industry_avg: 8.0, workforce: 3200, temp_workers: 890, capacity_utilization: 87.8, year_established: 1969 },
      { name: "Chesapeake Alloys", units_produced: 267_100, units_reported_by_trade_journal: 269_000, defects: 145, defects_prior_year: 157, cost_per_unit: 148, cost_per_unit_competitor_estimate: 144, lead_time_days: 25, lead_time_days_last_quarter: 27, quality_score: 8.8, quality_score_industry_avg: 8.0, workforce: 2000, temp_workers: 350, capacity_utilization: 78.9, year_established: 1982 },
    ],
  },
  "South America": {
    region: "South America",
    suppliers: [
      { name: "Patagonia Steel", units_produced: 234_500, units_reported_by_trade_journal: 236_800, defects: 312, defects_prior_year: 338, cost_per_unit: 155, cost_per_unit_competitor_estimate: 151, lead_time_days: 51, lead_time_days_last_quarter: 54, quality_score: 6.9, quality_score_industry_avg: 7.2, workforce: 3100, temp_workers: 1200, capacity_utilization: 71.2, year_established: 1987 },
      { name: "Amazonia Metals", units_produced: 189_200, units_reported_by_trade_journal: 191_000, defects: 267, defects_prior_year: 289, cost_per_unit: 88, cost_per_unit_competitor_estimate: 85, lead_time_days: 42, lead_time_days_last_quarter: 45, quality_score: 6.5, quality_score_industry_avg: 7.2, workforce: 4200, temp_workers: 1800, capacity_utilization: 66.3, year_established: 2003 },
      { name: "Andean Fabrication", units_produced: 156_800, units_reported_by_trade_journal: 158_500, defects: 198, defects_prior_year: 215, cost_per_unit: 102, cost_per_unit_competitor_estimate: 99, lead_time_days: 38, lead_time_days_last_quarter: 41, quality_score: 7.1, quality_score_industry_avg: 7.2, workforce: 2800, temp_workers: 950, capacity_utilization: 68.7, year_established: 1995 },
      { name: "Pampas Industrial", units_produced: 278_900, units_reported_by_trade_journal: 281_200, defects: 234, defects_prior_year: 253, cost_per_unit: 115, cost_per_unit_competitor_estimate: 112, lead_time_days: 35, lead_time_days_last_quarter: 37, quality_score: 7.6, quality_score_industry_avg: 7.2, workforce: 2400, temp_workers: 680, capacity_utilization: 74.5, year_established: 1991 },
      { name: "Orinoco Castings", units_produced: 134_500, units_reported_by_trade_journal: 136_200, defects: 189, defects_prior_year: 205, cost_per_unit: 78, cost_per_unit_competitor_estimate: 75, lead_time_days: 44, lead_time_days_last_quarter: 47, quality_score: 6.3, quality_score_industry_avg: 7.2, workforce: 3500, temp_workers: 1500, capacity_utilization: 62.1, year_established: 2009 },
      { name: "Cerrado Components", units_produced: 212_700, units_reported_by_trade_journal: 214_500, defects: 178, defects_prior_year: 193, cost_per_unit: 97, cost_per_unit_competitor_estimate: 94, lead_time_days: 37, lead_time_days_last_quarter: 39, quality_score: 7.3, quality_score_industry_avg: 7.2, workforce: 2600, temp_workers: 780, capacity_utilization: 70.8, year_established: 1999 },
      { name: "Altiplano Alloys", units_produced: 145_600, units_reported_by_trade_journal: 147_300, defects: 212, defects_prior_year: 231, cost_per_unit: 84, cost_per_unit_competitor_estimate: 81, lead_time_days: 41, lead_time_days_last_quarter: 44, quality_score: 6.7, quality_score_industry_avg: 7.2, workforce: 3200, temp_workers: 1300, capacity_utilization: 64.5, year_established: 2006 },
      { name: "Llanos Metalworks", units_produced: 167_800, units_reported_by_trade_journal: 169_500, defects: 223, defects_prior_year: 241, cost_per_unit: 91, cost_per_unit_competitor_estimate: 88, lead_time_days: 39, lead_time_days_last_quarter: 42, quality_score: 6.8, quality_score_industry_avg: 7.2, workforce: 2900, temp_workers: 1100, capacity_utilization: 67.2, year_established: 2001 },
    ],
  },
  Scandinavia: {
    region: "Scandinavia",
    suppliers: [
      { name: "Nordic Forge", units_produced: 486_800, units_reported_by_trade_journal: 489_500, defects: 156, defects_prior_year: 167, cost_per_unit: 178, cost_per_unit_competitor_estimate: 174, lead_time_days: 26, lead_time_days_last_quarter: 28, quality_score: 9.2, quality_score_industry_avg: 8.8, workforce: 3100, temp_workers: 420, capacity_utilization: 92.1, year_established: 1938 },
      { name: "Fjord Industries", units_produced: 334_200, units_reported_by_trade_journal: 336_500, defects: 123, defects_prior_year: 131, cost_per_unit: 192, cost_per_unit_competitor_estimate: 187, lead_time_days: 30, lead_time_days_last_quarter: 32, quality_score: 9.5, quality_score_industry_avg: 8.8, workforce: 2400, temp_workers: 310, capacity_utilization: 85.4, year_established: 1955 },
      { name: "Baltic Fabrication", units_produced: 267_500, units_reported_by_trade_journal: 269_800, defects: 145, defects_prior_year: 156, cost_per_unit: 165, cost_per_unit_competitor_estimate: 161, lead_time_days: 28, lead_time_days_last_quarter: 30, quality_score: 8.9, quality_score_industry_avg: 8.8, workforce: 2000, temp_workers: 350, capacity_utilization: 80.6, year_established: 1972 },
      { name: "Lappland Materials", units_produced: 198_900, units_reported_by_trade_journal: 200_500, defects: 89, defects_prior_year: 96, cost_per_unit: 215, cost_per_unit_competitor_estimate: 210, lead_time_days: 34, lead_time_days_last_quarter: 36, quality_score: 9.7, quality_score_industry_avg: 8.8, workforce: 1200, temp_workers: 180, capacity_utilization: 72.8, year_established: 1961 },
      { name: "Aland Precision", units_produced: 156_700, units_reported_by_trade_journal: 158_200, defects: 78, defects_prior_year: 84, cost_per_unit: 234, cost_per_unit_competitor_estimate: 228, lead_time_days: 37, lead_time_days_last_quarter: 39, quality_score: 9.8, quality_score_industry_avg: 8.8, workforce: 900, temp_workers: 120, capacity_utilization: 68.1, year_established: 1949 },
      { name: "Gothenburg Works", units_produced: 378_400, units_reported_by_trade_journal: 380_800, defects: 198, defects_prior_year: 213, cost_per_unit: 152, cost_per_unit_competitor_estimate: 148, lead_time_days: 24, lead_time_days_last_quarter: 26, quality_score: 8.7, quality_score_industry_avg: 8.8, workforce: 2800, temp_workers: 510, capacity_utilization: 88.3, year_established: 1945 },
      { name: "Stavanger Alloys", units_produced: 289_100, units_reported_by_trade_journal: 291_400, defects: 134, defects_prior_year: 143, cost_per_unit: 175, cost_per_unit_competitor_estimate: 171, lead_time_days: 27, lead_time_days_last_quarter: 29, quality_score: 9.1, quality_score_industry_avg: 8.8, workforce: 2100, temp_workers: 340, capacity_utilization: 82.7, year_established: 1968 },
      { name: "Helsinki Castings", units_produced: 223_600, units_reported_by_trade_journal: 225_200, defects: 112, defects_prior_year: 120, cost_per_unit: 189, cost_per_unit_competitor_estimate: 184, lead_time_days: 31, lead_time_days_last_quarter: 33, quality_score: 9.3, quality_score_industry_avg: 8.8, workforce: 1700, temp_workers: 260, capacity_utilization: 77.4, year_established: 1958 },
    ],
  },
  Alps: {
    region: "Alpine Region",
    suppliers: [
      { name: "Helvetia Precision", units_produced: 385_000, units_reported_by_trade_journal: 387_500, defects: 112, defects_prior_year: 89, cost_per_unit: 205, cost_per_unit_competitor_estimate: 200, lead_time_days: 32, lead_time_days_last_quarter: 34, quality_score: 9.5, quality_score_industry_avg: 9.0, workforce: 2500, temp_workers: 320, capacity_utilization: 84.2, year_established: 1943 },
      { name: "Tyrolean Metalworks", units_produced: 267_300, units_reported_by_trade_journal: 269_500, defects: 134, defects_prior_year: 143, cost_per_unit: 178, cost_per_unit_competitor_estimate: 174, lead_time_days: 29, lead_time_days_last_quarter: 31, quality_score: 9.1, quality_score_industry_avg: 9.0, workforce: 1800, temp_workers: 280, capacity_utilization: 79.6, year_established: 1956 },
      { name: "Bavarian Components", units_produced: 345_200, units_reported_by_trade_journal: 347_600, defects: 178, defects_prior_year: 190, cost_per_unit: 162, cost_per_unit_competitor_estimate: 158, lead_time_days: 26, lead_time_days_last_quarter: 28, quality_score: 8.8, quality_score_industry_avg: 9.0, workforce: 2900, temp_workers: 480, capacity_utilization: 86.8, year_established: 1964 },
      { name: "Dolomite Alloys", units_produced: 198_400, units_reported_by_trade_journal: 200_100, defects: 98, defects_prior_year: 105, cost_per_unit: 221, cost_per_unit_competitor_estimate: 216, lead_time_days: 35, lead_time_days_last_quarter: 37, quality_score: 9.6, quality_score_industry_avg: 9.0, workforce: 1300, temp_workers: 190, capacity_utilization: 73.5, year_established: 1951 },
      { name: "Jura Fabrication", units_produced: 234_700, units_reported_by_trade_journal: 236_300, defects: 145, defects_prior_year: 156, cost_per_unit: 185, cost_per_unit_competitor_estimate: 180, lead_time_days: 31, lead_time_days_last_quarter: 33, quality_score: 9.2, quality_score_industry_avg: 9.0, workforce: 1600, temp_workers: 240, capacity_utilization: 77.1, year_established: 1959 },
      { name: "Engadin Works", units_produced: 312_600, units_reported_by_trade_journal: 314_800, defects: 167, defects_prior_year: 179, cost_per_unit: 155, cost_per_unit_competitor_estimate: 151, lead_time_days: 27, lead_time_days_last_quarter: 29, quality_score: 8.7, quality_score_industry_avg: 9.0, workforce: 2200, temp_workers: 390, capacity_utilization: 83.4, year_established: 1971 },
      { name: "Vorarlberg Castings", units_produced: 178_900, units_reported_by_trade_journal: 180_400, defects: 89, defects_prior_year: 95, cost_per_unit: 238, cost_per_unit_competitor_estimate: 232, lead_time_days: 38, lead_time_days_last_quarter: 40, quality_score: 9.7, quality_score_industry_avg: 9.0, workforce: 1100, temp_workers: 160, capacity_utilization: 69.8, year_established: 1947 },
      { name: "Bernese Metals", units_produced: 289_400, units_reported_by_trade_journal: 291_700, defects: 156, defects_prior_year: 167, cost_per_unit: 168, cost_per_unit_competitor_estimate: 164, lead_time_days: 28, lead_time_days_last_quarter: 30, quality_score: 9.0, quality_score_industry_avg: 9.0, workforce: 2000, temp_workers: 330, capacity_utilization: 81.2, year_established: 1966 },
    ],
  },
  "Central Asia": {
    region: "Central Asia",
    suppliers: [
      { name: "Ural Heavy Industries", units_produced: 423_100, units_reported_by_trade_journal: 426_000, defects: 378, defects_prior_year: 412, cost_per_unit: 178, cost_per_unit_competitor_estimate: 173, lead_time_days: 52, lead_time_days_last_quarter: 56, quality_score: 7.1, quality_score_industry_avg: 6.8, workforce: 5800, temp_workers: 2400, capacity_utilization: 78.9, year_established: 1941 },
      { name: "Kazakh Metals Corp", units_produced: 312_400, units_reported_by_trade_journal: 314_800, defects: 289, defects_prior_year: 312, cost_per_unit: 92, cost_per_unit_competitor_estimate: 89, lead_time_days: 43, lead_time_days_last_quarter: 46, quality_score: 6.4, quality_score_industry_avg: 6.8, workforce: 4500, temp_workers: 1900, capacity_utilization: 72.1, year_established: 1953 },
      { name: "Gobi Materials", units_produced: 178_500, units_reported_by_trade_journal: 180_200, defects: 145, defects_prior_year: 156, cost_per_unit: 162, cost_per_unit_competitor_estimate: 158, lead_time_days: 48, lead_time_days_last_quarter: 51, quality_score: 8.3, quality_score_industry_avg: 6.8, workforce: 1800, temp_workers: 420, capacity_utilization: 68.4, year_established: 1998 },
      { name: "Silk Road Fabrication", units_produced: 234_700, units_reported_by_trade_journal: 236_500, defects: 234, defects_prior_year: 253, cost_per_unit: 108, cost_per_unit_competitor_estimate: 105, lead_time_days: 39, lead_time_days_last_quarter: 42, quality_score: 7.0, quality_score_industry_avg: 6.8, workforce: 3200, temp_workers: 1200, capacity_utilization: 74.6, year_established: 1985 },
      { name: "Tashkent Alloys", units_produced: 267_800, units_reported_by_trade_journal: 269_500, defects: 256, defects_prior_year: 278, cost_per_unit: 98, cost_per_unit_competitor_estimate: 95, lead_time_days: 41, lead_time_days_last_quarter: 44, quality_score: 6.6, quality_score_industry_avg: 6.8, workforce: 3800, temp_workers: 1600, capacity_utilization: 76.3, year_established: 1967 },
      { name: "Caspian Components", units_produced: 198_200, units_reported_by_trade_journal: 200_000, defects: 198, defects_prior_year: 214, cost_per_unit: 115, cost_per_unit_competitor_estimate: 112, lead_time_days: 37, lead_time_days_last_quarter: 40, quality_score: 7.2, quality_score_industry_avg: 6.8, workforce: 2900, temp_workers: 980, capacity_utilization: 70.5, year_established: 1979 },
      { name: "Altai Precision", units_produced: 145_600, units_reported_by_trade_journal: 147_200, defects: 123, defects_prior_year: 134, cost_per_unit: 145, cost_per_unit_competitor_estimate: 141, lead_time_days: 35, lead_time_days_last_quarter: 37, quality_score: 7.8, quality_score_industry_avg: 6.8, workforce: 1600, temp_workers: 450, capacity_utilization: 65.8, year_established: 1992 },
      { name: "Aral Metalworks", units_produced: 189_300, units_reported_by_trade_journal: 191_000, defects: 212, defects_prior_year: 229, cost_per_unit: 105, cost_per_unit_competitor_estimate: 102, lead_time_days: 40, lead_time_days_last_quarter: 43, quality_score: 6.7, quality_score_industry_avg: 6.8, workforce: 3400, temp_workers: 1400, capacity_utilization: 71.2, year_established: 1974 },
    ],
  },
  Africa: {
    region: "Sub-Saharan Africa",
    suppliers: [
      { name: "Saharan Metals", units_produced: 198_400, units_reported_by_trade_journal: 200_200, defects: 267, defects_prior_year: 289, cost_per_unit: 171, cost_per_unit_competitor_estimate: 167, lead_time_days: 47, lead_time_days_last_quarter: 50, quality_score: 7.8, quality_score_industry_avg: 6.5, workforce: 3800, temp_workers: 1600, capacity_utilization: 69.1, year_established: 1989 },
      { name: "Zambezi Foundry", units_produced: 145_200, units_reported_by_trade_journal: 146_800, defects: 198, defects_prior_year: 215, cost_per_unit: 82, cost_per_unit_competitor_estimate: 79, lead_time_days: 44, lead_time_days_last_quarter: 47, quality_score: 6.1, quality_score_industry_avg: 6.5, workforce: 4200, temp_workers: 1900, capacity_utilization: 62.4, year_established: 2007 },
      { name: "Highveld Components", units_produced: 289_700, units_reported_by_trade_journal: 292_000, defects: 234, defects_prior_year: 253, cost_per_unit: 118, cost_per_unit_competitor_estimate: 115, lead_time_days: 36, lead_time_days_last_quarter: 38, quality_score: 7.5, quality_score_industry_avg: 6.5, workforce: 2800, temp_workers: 920, capacity_utilization: 75.3, year_established: 1982 },
      { name: "Rift Valley Alloys", units_produced: 112_300, units_reported_by_trade_journal: 113_800, defects: 178, defects_prior_year: 193, cost_per_unit: 74, cost_per_unit_competitor_estimate: 71, lead_time_days: 49, lead_time_days_last_quarter: 52, quality_score: 5.8, quality_score_industry_avg: 6.5, workforce: 5100, temp_workers: 2300, capacity_utilization: 58.7, year_established: 2012 },
      { name: "Congo Basin Works", units_produced: 134_800, units_reported_by_trade_journal: 136_500, defects: 212, defects_prior_year: 231, cost_per_unit: 68, cost_per_unit_competitor_estimate: 65, lead_time_days: 53, lead_time_days_last_quarter: 57, quality_score: 5.4, quality_score_industry_avg: 6.5, workforce: 5800, temp_workers: 2700, capacity_utilization: 55.2, year_established: 2015 },
      { name: "Limpopo Steel", units_produced: 223_500, units_reported_by_trade_journal: 225_300, defects: 189, defects_prior_year: 205, cost_per_unit: 105, cost_per_unit_competitor_estimate: 102, lead_time_days: 38, lead_time_days_last_quarter: 41, quality_score: 7.2, quality_score_industry_avg: 6.5, workforce: 3200, temp_workers: 1100, capacity_utilization: 72.8, year_established: 1993 },
      { name: "Nile Delta Fabrication", units_produced: 178_600, units_reported_by_trade_journal: 180_300, defects: 201, defects_prior_year: 218, cost_per_unit: 92, cost_per_unit_competitor_estimate: 89, lead_time_days: 42, lead_time_days_last_quarter: 45, quality_score: 6.6, quality_score_industry_avg: 6.5, workforce: 3600, temp_workers: 1400, capacity_utilization: 67.5, year_established: 2000 },
      { name: "Kalahari Metals", units_produced: 156_900, units_reported_by_trade_journal: 158_400, defects: 178, defects_prior_year: 193, cost_per_unit: 88, cost_per_unit_competitor_estimate: 85, lead_time_days: 40, lead_time_days_last_quarter: 43, quality_score: 6.8, quality_score_industry_avg: 6.5, workforce: 3400, temp_workers: 1300, capacity_utilization: 65.1, year_established: 2004 },
    ],
  },
  Oceania: {
    region: "Oceania & Pacific",
    suppliers: [
      { name: "Pacifica Alloys", units_produced: 487_200, units_reported_by_trade_journal: 489_000, defects: 198, defects_prior_year: 213, cost_per_unit: 145, cost_per_unit_competitor_estimate: 141, lead_time_days: 28, lead_time_days_last_quarter: 30, quality_score: 8.9, quality_score_industry_avg: 7.8, workforce: 3500, temp_workers: 680, capacity_utilization: 91.7, year_established: 1958 },
      { name: "Outback Foundry", units_produced: 356_800, units_reported_by_trade_journal: 359_100, defects: 234, defects_prior_year: 253, cost_per_unit: 112, cost_per_unit_competitor_estimate: 109, lead_time_days: 24, lead_time_days_last_quarter: 26, quality_score: 8.1, quality_score_industry_avg: 7.8, workforce: 2900, temp_workers: 620, capacity_utilization: 86.3, year_established: 1971 },
      { name: "Tasman Components", units_produced: 278_400, units_reported_by_trade_journal: 280_600, defects: 167, defects_prior_year: 179, cost_per_unit: 138, cost_per_unit_competitor_estimate: 134, lead_time_days: 27, lead_time_days_last_quarter: 29, quality_score: 8.6, quality_score_industry_avg: 7.8, workforce: 2200, temp_workers: 410, capacity_utilization: 82.5, year_established: 1984 },
      { name: "Coral Sea Metals", units_produced: 189_700, units_reported_by_trade_journal: 191_400, defects: 145, defects_prior_year: 156, cost_per_unit: 128, cost_per_unit_competitor_estimate: 125, lead_time_days: 31, lead_time_days_last_quarter: 33, quality_score: 8.3, quality_score_industry_avg: 7.8, workforce: 1800, temp_workers: 350, capacity_utilization: 76.8, year_established: 1992 },
      { name: "Polynesia Steel", units_produced: 112_500, units_reported_by_trade_journal: 113_800, defects: 178, defects_prior_year: 193, cost_per_unit: 95, cost_per_unit_competitor_estimate: 92, lead_time_days: 38, lead_time_days_last_quarter: 41, quality_score: 6.9, quality_score_industry_avg: 7.8, workforce: 2600, temp_workers: 980, capacity_utilization: 64.2, year_established: 2008 },
      { name: "Kimberley Fabrication", units_produced: 312_100, units_reported_by_trade_journal: 314_400, defects: 201, defects_prior_year: 217, cost_per_unit: 125, cost_per_unit_competitor_estimate: 121, lead_time_days: 25, lead_time_days_last_quarter: 27, quality_score: 8.2, quality_score_industry_avg: 7.8, workforce: 2500, temp_workers: 520, capacity_utilization: 84.1, year_established: 1976 },
      { name: "Canterbury Alloys", units_produced: 234_600, units_reported_by_trade_journal: 236_200, defects: 145, defects_prior_year: 156, cost_per_unit: 152, cost_per_unit_competitor_estimate: 148, lead_time_days: 29, lead_time_days_last_quarter: 31, quality_score: 8.7, quality_score_industry_avg: 7.8, workforce: 1700, temp_workers: 300, capacity_utilization: 79.3, year_established: 1965 },
      { name: "Torres Strait Works", units_produced: 167_300, units_reported_by_trade_journal: 169_000, defects: 189, defects_prior_year: 205, cost_per_unit: 108, cost_per_unit_competitor_estimate: 105, lead_time_days: 33, lead_time_days_last_quarter: 35, quality_score: 7.5, quality_score_industry_avg: 7.8, workforce: 2100, temp_workers: 780, capacity_utilization: 71.6, year_established: 1999 },
    ],
  },
  "South Asia": {
    region: "South Asia",
    suppliers: [
      { name: "Deccan Manufacturing", units_produced: 423_800, units_reported_by_trade_journal: 426_500, defects: 345, defects_prior_year: 378, cost_per_unit: 72, cost_per_unit_competitor_estimate: 69, lead_time_days: 31, lead_time_days_last_quarter: 34, quality_score: 7.2, quality_score_industry_avg: 6.9, workforce: 6200, temp_workers: 2800, capacity_utilization: 82.4, year_established: 1976 },
      { name: "Bengal Industrial", units_produced: 312_500, units_reported_by_trade_journal: 314_800, defects: 289, defects_prior_year: 312, cost_per_unit: 65, cost_per_unit_competitor_estimate: 62, lead_time_days: 34, lead_time_days_last_quarter: 37, quality_score: 6.8, quality_score_industry_avg: 6.9, workforce: 5400, temp_workers: 2400, capacity_utilization: 78.1, year_established: 1983 },
      { name: "Indus Precision", units_produced: 234_100, units_reported_by_trade_journal: 236_000, defects: 178, defects_prior_year: 193, cost_per_unit: 88, cost_per_unit_competitor_estimate: 85, lead_time_days: 29, lead_time_days_last_quarter: 31, quality_score: 7.6, quality_score_industry_avg: 6.9, workforce: 3200, temp_workers: 980, capacity_utilization: 75.6, year_established: 1991 },
      { name: "Tamil Components", units_produced: 378_200, units_reported_by_trade_journal: 380_500, defects: 312, defects_prior_year: 338, cost_per_unit: 68, cost_per_unit_competitor_estimate: 65, lead_time_days: 32, lead_time_days_last_quarter: 35, quality_score: 7.0, quality_score_industry_avg: 6.9, workforce: 5800, temp_workers: 2600, capacity_utilization: 80.9, year_established: 1979 },
      { name: "Ganges Alloys", units_produced: 289_600, units_reported_by_trade_journal: 291_300, defects: 256, defects_prior_year: 278, cost_per_unit: 75, cost_per_unit_competitor_estimate: 72, lead_time_days: 30, lead_time_days_last_quarter: 33, quality_score: 7.1, quality_score_industry_avg: 6.9, workforce: 4600, temp_workers: 1900, capacity_utilization: 77.3, year_established: 1986 },
      { name: "Lankan Fabrication", units_produced: 156_400, units_reported_by_trade_journal: 158_100, defects: 198, defects_prior_year: 215, cost_per_unit: 58, cost_per_unit_competitor_estimate: 55, lead_time_days: 37, lead_time_days_last_quarter: 40, quality_score: 6.3, quality_score_industry_avg: 6.9, workforce: 4100, temp_workers: 1800, capacity_utilization: 66.5, year_established: 2005 },
      { name: "Himalayan Metals", units_produced: 178_700, units_reported_by_trade_journal: 180_400, defects: 212, defects_prior_year: 230, cost_per_unit: 82, cost_per_unit_competitor_estimate: 79, lead_time_days: 35, lead_time_days_last_quarter: 38, quality_score: 6.9, quality_score_industry_avg: 6.9, workforce: 3800, temp_workers: 1500, capacity_utilization: 70.8, year_established: 1997 },
      { name: "Rajasthan Castings", units_produced: 267_900, units_reported_by_trade_journal: 269_600, defects: 234, defects_prior_year: 253, cost_per_unit: 78, cost_per_unit_competitor_estimate: 75, lead_time_days: 33, lead_time_days_last_quarter: 36, quality_score: 7.3, quality_score_industry_avg: 6.9, workforce: 4200, temp_workers: 1700, capacity_utilization: 76.4, year_established: 1988 },
    ],
  },
  "Middle East": {
    region: "Middle East & North Africa",
    suppliers: [
      { name: "Arabian Gulf Industries", units_produced: 378_500, units_reported_by_trade_journal: 381_000, defects: 234, defects_prior_year: 253, cost_per_unit: 135, cost_per_unit_competitor_estimate: 131, lead_time_days: 26, lead_time_days_last_quarter: 28, quality_score: 8.2, quality_score_industry_avg: 7.4, workforce: 3400, temp_workers: 1200, capacity_utilization: 84.6, year_established: 1978 },
      { name: "Nile Fabrication", units_produced: 234_200, units_reported_by_trade_journal: 236_000, defects: 189, defects_prior_year: 205, cost_per_unit: 98, cost_per_unit_competitor_estimate: 95, lead_time_days: 33, lead_time_days_last_quarter: 36, quality_score: 7.3, quality_score_industry_avg: 7.4, workforce: 2800, temp_workers: 950, capacity_utilization: 76.2, year_established: 1991 },
      { name: "Mesopotamia Metals", units_produced: 312_700, units_reported_by_trade_journal: 315_000, defects: 267, defects_prior_year: 289, cost_per_unit: 112, cost_per_unit_competitor_estimate: 109, lead_time_days: 29, lead_time_days_last_quarter: 31, quality_score: 7.6, quality_score_industry_avg: 7.4, workforce: 3100, temp_workers: 1100, capacity_utilization: 80.5, year_established: 1985 },
      { name: "Levant Components", units_produced: 189_800, units_reported_by_trade_journal: 191_500, defects: 156, defects_prior_year: 168, cost_per_unit: 145, cost_per_unit_competitor_estimate: 141, lead_time_days: 31, lead_time_days_last_quarter: 33, quality_score: 8.1, quality_score_industry_avg: 7.4, workforce: 2000, temp_workers: 520, capacity_utilization: 73.8, year_established: 1996 },
      { name: "Maghreb Alloys", units_produced: 267_400, units_reported_by_trade_journal: 269_200, defects: 212, defects_prior_year: 229, cost_per_unit: 108, cost_per_unit_competitor_estimate: 105, lead_time_days: 30, lead_time_days_last_quarter: 32, quality_score: 7.5, quality_score_industry_avg: 7.4, workforce: 2600, temp_workers: 880, capacity_utilization: 78.1, year_established: 1988 },
      { name: "Persian Works", units_produced: 345_100, units_reported_by_trade_journal: 347_400, defects: 245, defects_prior_year: 265, cost_per_unit: 122, cost_per_unit_competitor_estimate: 118, lead_time_days: 27, lead_time_days_last_quarter: 29, quality_score: 7.9, quality_score_industry_avg: 7.4, workforce: 3000, temp_workers: 1050, capacity_utilization: 82.3, year_established: 1981 },
      { name: "Anatolian Steel", units_produced: 398_600, units_reported_by_trade_journal: 401_000, defects: 278, defects_prior_year: 301, cost_per_unit: 118, cost_per_unit_competitor_estimate: 115, lead_time_days: 25, lead_time_days_last_quarter: 27, quality_score: 7.8, quality_score_industry_avg: 7.4, workforce: 3600, temp_workers: 1300, capacity_utilization: 86.1, year_established: 1973 },
      { name: "Sinai Fabrication", units_produced: 156_300, units_reported_by_trade_journal: 158_000, defects: 178, defects_prior_year: 193, cost_per_unit: 85, cost_per_unit_competitor_estimate: 82, lead_time_days: 36, lead_time_days_last_quarter: 39, quality_score: 6.8, quality_score_industry_avg: 7.4, workforce: 2200, temp_workers: 780, capacity_utilization: 68.4, year_established: 2003 },
    ],
  },
};

function generateExtremeReport(region: RegionData): string {
  const parts: string[] = [];

  parts.push(
    `The ${region.region} manufacturing landscape presents a complex picture for the current fiscal period. ` +
    `Regional analysts from multiple independent research firms have compiled production data, though as is often ` +
    `the case with cross-border manufacturing statistics, there are notable discrepancies between official company ` +
    `filings, trade journal estimates, and third-party audit results. The following synthesis attempts to reconcile ` +
    `these sources while noting where significant disagreements persist. Capacity utilisation across the region ` +
    `varies considerably, and workforce figures include varying proportions of temporary and contract labour depending ` +
    `on local reporting standards. All cost figures are normalised to USD at prevailing exchange rates, though ` +
    `purchasing power parity adjustments might yield different conclusions. Defect counts reflect the standardised ` +
    `ISO 9001 methodology unless otherwise noted, and quality scores are on the universal 1-10 composite scale ` +
    `incorporating process maturity, output consistency, and customer satisfaction metrics.`,
  );

  for (const s of region.suppliers) {
    const totalWorkforce = s.workforce + s.temp_workers;
    const altDefectRate = ((s.defects / s.units_produced) * 100).toFixed(4);
    const priorDefectRate = ((s.defects_prior_year / (s.units_produced * 0.95)) * 100).toFixed(4);

    parts.push(
      `Turning to ${s.name}, which was established in ${s.year_established} and operates with a total workforce ` +
      `of approximately ${totalWorkforce.toLocaleString()} individuals (of whom ${s.workforce.toLocaleString()} are classified as permanent ` +
      `full-time employees and the remaining ${s.temp_workers.toLocaleString()} are temporary or contract workers engaged on ` +
      `varying terms), the company reported audited production output of ${s.units_produced.toLocaleString()} units for the ` +
      `period under review. It is worth noting that the ${region.region} Trade Journal published a somewhat higher ` +
      `figure of ${s.units_reported_by_trade_journal.toLocaleString()} units, which appears to include units that were in final ` +
      `quality assurance stages but had not yet passed final inspection at the reporting date; the company itself ` +
      `has confirmed the lower figure of ${s.units_produced.toLocaleString()} as the definitive audited count. In the prior ` +
      `fiscal year, production was estimated at roughly ${Math.round(s.units_produced * 0.95).toLocaleString()} units, suggesting ` +
      `year-on-year growth of approximately ${((1 / 0.95 - 1) * 100).toFixed(1)}% on an absolute basis though some of this ` +
      `may reflect capacity expansion rather than efficiency gains given that capacity utilisation currently stands ` +
      `at ${s.capacity_utilization}% compared to the regional average of roughly ${(s.capacity_utilization * 0.95).toFixed(1)}%. ` +
      `The defect count under ISO 9001 criteria was recorded at ${s.defects} units, yielding a per-unit defect rate ` +
      `of ${altDefectRate}%, which represents a ${s.defects < s.defects_prior_year ? "favourable improvement" : "concerning increase"} ` +
      `compared to the prior year figure of ${s.defects_prior_year} defects (approximately ${priorDefectRate}% on the then-lower ` +
      `production base). An alternative methodology used by some regional auditors, which counts partial defects at ` +
      `half weight, would yield an adjusted defect count closer to ${Math.round(s.defects * 0.7)} but this is not the ` +
      `standard measure. Unit production cost was reported at $${s.cost_per_unit} per unit according to company filings, ` +
      `although a competitor intelligence report circulated in the industry suggests the true all-in cost may be closer ` +
      `to $${s.cost_per_unit_competitor_estimate} when accounting for unreported logistics surcharges and quality remediation ` +
      `expenses; for the purposes of this analysis we rely on the company-reported figure of $${s.cost_per_unit}. Lead time ` +
      `from order placement to delivery averaged ${s.lead_time_days} calendar days during the current period, compared to ` +
      `${s.lead_time_days_last_quarter} days in the previous quarter, and the composite quality score assigned by the ` +
      `independent rating consortium stands at ${s.quality_score} against a regional industry average of ` +
      `${s.quality_score_industry_avg}. It should be noted that quality scoring methodologies were revised in the ` +
      `most recent assessment cycle, and direct comparison with scores published more than two years ago requires ` +
      `a correction factor of approximately 0.3 points upward on the legacy scale.`,
    );
  }

  parts.push(
    `This concludes the regional assessment for ${region.region}. Readers are cautioned that all figures represent ` +
    `point-in-time estimates and may be subject to revision in subsequent reporting periods as audits are finalised ` +
    `and exchange rate adjustments are applied retroactively.`,
  );

  return parts.join(" ");
}

const analyzeRegion = tool(
  async (input) => {
    const regionKey = Object.keys(REGION_DATABASE).find(
      (k) =>
        k.toLowerCase() === input.region.toLowerCase() ||
        REGION_DATABASE[k].region.toLowerCase() ===
          input.region.toLowerCase(),
    );
    if (!regionKey) return `No data found for region: ${input.region}`;
    return generateExtremeReport(REGION_DATABASE[regionKey]);
  },
  {
    name: "analyze_region",
    description:
      "Retrieve a detailed supply chain analyst report for a manufacturing region, covering 8 suppliers with production units, defects, costs, lead times, quality scores, and workforce data.",
    schema: z.object({
      region: z
        .string()
        .describe(
          "Region name (e.g. 'East Asia', 'Western Europe', 'North America', 'South America', 'Scandinavia', 'Alps', 'Central Asia', 'Africa', 'Oceania', 'South Asia', 'Middle East')",
        ),
    }),
  },
);

const regionSupplierSchema = z.object({
  suppliers: z
    .array(
      z.object({
        name: z.string().describe("Supplier name"),
        units_produced: z
          .number()
          .describe("Audited production unit count"),
        defects: z.number().describe("ISO 9001 defect count"),
        cost_per_unit: z
          .number()
          .describe("Company-reported cost per unit in USD"),
        lead_time_days: z
          .number()
          .describe("Current period lead time in calendar days"),
        quality_score: z
          .number()
          .describe("Composite quality score on 1-10 scale"),
      }),
    )
    .describe("Array of suppliers in this region"),
});

const EVAL_E_REGIONS = [
  "East Asia", "Western Europe", "North America", "South America",
  "Scandinavia", "Alps", "Central Asia", "Africa", "Oceania",
  "South Asia", "Middle East",
];

const EVAL_E_QUERY =
  `Analyze all 11 regions: ${EVAL_E_REGIONS.join(", ")}. ` +
  "Use the AUDITED production figures (not trade journal estimates) and company-reported costs (not competitor estimates). " +
  "Use the ISO 9001 defect count for the CURRENT period (not prior year, not adjusted). " +
  "Then answer these questions precisely:\n" +
  "1. Which supplier across all regions has the highest audited units_produced? Give the exact name and number.\n" +
  "2. Which supplier has the lowest defect rate (defects divided by audited units_produced)? Give the exact name and the ratio.\n" +
  "3. List every supplier where lead_time_days > 45 AND cost_per_unit > $150. " +
  "Among those, which has the highest quality_score? Give the name and score.";

const evalEAgents = createEvalAgents({
  subagentName: "regional_analyst",
  description:
    "Analyzes a manufacturing region using the analyze_region tool. Returns data on 8 suppliers including production units, defects, costs, lead times, and quality scores.",
  systemPrompt:
    "You are a supply chain analyst. When given a region, use the analyze_region tool to retrieve the report. " +
    "Extract data for each supplier carefully. Use audited figures, not trade journal estimates. " +
    "Use current-period defects, not prior year. Use company-reported costs, not competitor estimates.",
  tools: [analyzeRegion],
  schema: regionSupplierSchema,
  supervisorContext:
    "You are a global supply chain supervisor. Delegate each region analysis in parallel. " +
    "After receiving all results, answer the user's questions using exact numbers. " +
    "For defect rate, compute defects / audited units_produced for each supplier. " +
    "Be precise — many suppliers have very similar numbers so small differences matter.",
  dynamicSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      suppliers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            units_produced: { type: "number" },
            defects: { type: "number" },
            cost_per_unit: { type: "number" },
            lead_time_days: { type: "number" },
            quality_score: { type: "number" },
          },
          required: ["name", "units_produced", "defects", "cost_per_unit", "lead_time_days", "quality_score"],
        },
      },
    },
    required: ["suppliers"],
  }),
});

ls.describe("structured-output-eval-E-static", () => {
  ls.test(
    "extreme: 96 suppliers noisy wall-of-text with static responseFormat",
    { inputs: { query: EVAL_E_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalEAgents.staticAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Pacifica", true);
      expect(result).toHaveFinalTextContaining("Helvetia", true);
      expect(result).toHaveFinalTextContaining("Gobi", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-E-dynamic", () => {
  ls.test(
    "extreme: 96 suppliers noisy wall-of-text with dynamic response_schema",
    { inputs: { query: EVAL_E_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalEAgents.dynamicAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Pacifica", true);
      expect(result).toHaveFinalTextContaining("Helvetia", true);
      expect(result).toHaveFinalTextContaining("Gobi", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-E-freetext", () => {
  ls.test(
    "extreme: 96 suppliers noisy wall-of-text with free text",
    { inputs: { query: EVAL_E_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalEAgents.freeTextAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Pacifica", true);
      expect(result).toHaveFinalTextContaining("Helvetia", true);
      expect(result).toHaveFinalTextContaining("Gobi", true);
      expect(result).toHaveTokenUsage();
    },
  );
});

ls.describe("structured-output-eval-E-quickjs", () => {
  ls.test(
    "extreme: 96 suppliers noisy wall-of-text with QuickJS REPL + PTC",
    { inputs: { query: EVAL_E_QUERY } },
    async ({ inputs }) => {
      const result = await runAgent(evalEAgents.quickjsAgent, {
        query: inputs.query,
      });

      expect(result).toHaveFinalTextContaining("Pacifica", true);
      expect(result).toHaveFinalTextContaining("Helvetia", true);
      expect(result).toHaveFinalTextContaining("Gobi", true);
      expect(result).toHaveTokenUsage();
    },
  );
});
