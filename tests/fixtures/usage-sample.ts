// Numeric usage shapes captured from OpenCode ACP; no model API calls are needed.
export const contextUsage = {
  used: 179537, size: 1048576, cost: { amount: 0.04106725299999999, currency: "USD" },
};
export const promptUsage = {
  inputTokens: 105078, outputTokens: 9165, totalTokens: 8094326,
  thoughtTokens: 9866, cachedReadTokens: 7970217,
};
const { cachedReadTokens, ...totals } = promptUsage;
export const displayedPromptUsage = { ...totals, cachedTokens: cachedReadTokens };
