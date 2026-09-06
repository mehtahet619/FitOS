import { NearbyPlace } from "../../maps/provider";

export interface RankingWeights {
  foodMatch: number;
  distance: number;
  price: number;
  rating: number;
  availability: number;
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  foodMatch: 0.4,
  distance: 0.25,
  price: 0.15,
  rating: 0.15,
  availability: 0.05,
};

export interface RankInput {
  place: NearbyPlace;
  foodMatchScore: number; // 0-1, computed by caller from diet/allergy/keyword match
  userBudgetInr: number;
}

export function scorePlace(input: RankInput, weights: RankingWeights = DEFAULT_WEIGHTS): number {
  const { place, foodMatchScore, userBudgetInr } = input;

  const distanceScore = Math.max(0, 1 - place.distanceKm / 5); // 0km=1, 5km+=0
  const ratingScore = Math.max(0, Math.min(1, place.rating / 5));
  const cheapestDish = place.dishes.length
    ? Math.min(...place.dishes.map((d) => d.estPriceInr))
    : userBudgetInr;
  const priceScore = userBudgetInr > 0 ? Math.max(0, Math.min(1, 1 - cheapestDish / (userBudgetInr * 1.5))) : 0.5;
  const availabilityScore = place.isOpenNow ? 1 : 0;

  return (
    foodMatchScore * weights.foodMatch +
    distanceScore * weights.distance +
    priceScore * weights.price +
    ratingScore * weights.rating +
    availabilityScore * weights.availability
  );
}

export function rankPlaces(inputs: RankInput[], weights: RankingWeights = DEFAULT_WEIGHTS) {
  return inputs
    .map((i) => ({ place: i.place, score: scorePlace(i, weights) }))
    .sort((a, b) => b.score - a.score);
}
