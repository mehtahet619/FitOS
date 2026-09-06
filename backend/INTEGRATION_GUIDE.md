# Roboflow Workflow & Apify Swiggy Integration Guide

This document describes the integration of Roboflow's serverless workflow API and Apify's Swiggy scraper into the Adaptive Fit backend.

## Overview

### Roboflow Workflow Integration
- **Purpose**: Real-time gym equipment detection from camera images
- **Provider**: `src/vision/roboflowWorkflowProvider.ts`
- **Workflow**: het-mehta/general-segmentation-api-5
- **Endpoint**: https://serverless.roboflow.com

### Apify Swiggy Integration  
- **Purpose**: Discover nearby restaurants with menu items and pricing
- **Provider**: `src/maps/apifySwiggyProvider.ts`
- **API**: Apify REST API with Swiggy scraper actor

## Setup Instructions

### 1. Roboflow Workflow Setup

#### Get API Key
1. Visit [app.roboflow.com/settings/api](https://app.roboflow.com/settings/api)
2. Copy your workspace API key
3. Add to `.env`:
   ```
   ROBOFLOW_WORKFLOW_MODE="true"
   ROBOFLOW_API_KEY="your_api_key_here"
   ```

#### Verify Workflow
The workflow is preconfigured to use:
- Workspace: `het-mehta`
- Workflow ID: `general-segmentation-api-5`
- Detects: equipment and objects via segmentation API with class parameter

#### Usage
```typescript
POST /equipment/detect
Content-Type: application/json
Authorization: Bearer <jwt_token>

{
  "imageBase64": "iVBORw0KGgo..."  // raw base64, no data: prefix
}
```

**Response** (200 OK):
```json
{
  "configured": true,
  "detections": [
    {
      "equipmentName": "Dumbbells",
      "confidence": 0.95,
      "rawLabel": "dumbbell"
    }
  ],
  "suggestedExercises": [
    {
      "exerciseId": "...",
      "name": "Dumbbell Bench Press",
      "primaryMuscle": "chest",
      "howTo": "...",
      "equipmentUsed": ["Dumbbells", "Bench"]
    }
  ]
}
```

### 2. Apify Swiggy Integration

#### Get API Token
1. Sign up free at [apify.com](https://apify.com)
2. Go to **Account Settings** → **API tokens**
3. Create or copy your API token
4. Add to `.env`:
   ```
   MAPS_PROVIDER="apify_swiggy"
   APIFY_API_KEY="your_token_here"
   ```

#### How It Works
1. Accepts user location (latitude, longitude) and food query
2. Starts an Apify actor run to scrape Swiggy restaurants
3. Polls for completion (60-second timeout)
4. Transforms results to include distance, pricing, and menu items
5. Returns top 10 restaurants sorted by distance

#### Usage
```typescript
GET /food/nearby?lat=28.6139&lng=77.2090&foodId=pizza
Content-Type: application/json
Authorization: Bearer <jwt_token>
```

**Response** (200 OK):
```json
{
  "configured": true,
  "places": [
    {
      "id": "swiggy-pizza-hut",
      "name": "Pizza Hut",
      "distanceKm": 2.1,
      "rating": 4.2,
      "priceRange": "₹₹",
      "isOpenNow": true,
      "latitude": 28.6250,
      "longitude": 77.2100,
      "source": "Swiggy",
      "dishes": [
        {
          "name": "Margherita Pizza",
          "estPriceInr": 299,
          "estCalories": 500,
          "estProteinG": 12
        }
      ]
    }
  ]
}
```

## Architecture

### Roboflow Workflow Provider

**File**: `src/vision/roboflowWorkflowProvider.ts`

Key features:
- **Timeout handling**: 30-second request timeout with AbortController
- **Retry logic**: Exponential backoff (100ms, 300ms)
- **Defensive parsing**: Handles various workflow output formats
- **Equipment mapping**: Maps raw detections to known equipment in database
- **Deduplication**: Keeps highest confidence for each equipment type
- **Confidence clamping**: Ensures values are within 0-1 range

Request format:
```json
{
  "inputs": {
    "image": {
      "type": "base64",
      "value": "..."
    }
  }
}
```

Response format (workflow output):
```json
{
  "predictions": [
    { "class": "dumbbell", "confidence": 0.95 },
    { "class": "bench", "confidence": 0.87 }
  ]
}
```

### Apify Swiggy Provider

**File**: `src/maps/apifySwiggyProvider.ts`

Key features:
- **Actor management**: Starts and polls Apify actor runs
- **Distance calculation**: Haversine formula for accurate distance
- **Price estimation**: Converts delivery fees to price range (₹ to ₹₹₹₹)
- **Nutrition heuristics**: Estimates calories/protein by menu category
- **Graceful degradation**: Returns empty results on error instead of fabricating
- **Result sorting**: Orders by distance for better UX

Workflow:
1. Start actor run with location and search query
2. Poll `/api/v2/acts/runs/{runId}` for completion
3. Extract restaurants from successful run output
4. Transform to NearbyPlace format
5. Return top 10 by distance

## Equipment Label Mapping

The Roboflow provider maps raw model outputs to known Equipment table entries:

```typescript
const EQUIPMENT_LABEL_MAP: Record<string, string> = {
  dumbbell: "Dumbbells",
  dumbbells: "Dumbbells",
  barbell: "Barbell",
  bench: "Bench",
  "pull-up bar": "Pull-up Bar",
  "resistance band": "Resistance Bands",
  "cable machine": "Cable Machine",
  "squat rack": "Squat Rack",
  treadmill: "Treadmill",
  // ... see src/vision/equipmentVisionProvider.ts for complete mapping
};
```

Unmapped classes are silently ignored rather than invented.

## Troubleshooting

### Roboflow Workflow Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| 401/403 error | Invalid API key | Verify key at app.roboflow.com/settings/api |
| No detections | Poor image quality or lighting | Try clearer angle, better lighting |
| Timeout after 30s | Slow network or server | Check internet connection, Roboflow status page |
| Unknown equipment returned | Model saw new equipment class | Extend EQUIPMENT_LABEL_MAP in equipmentVisionProvider.ts |

### Apify Swiggy Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| 401/403 error | Invalid API token | Verify token at apify.com → Account Settings |
| Timeout after 60s | Swiggy site slow/unreachable | Check Swiggy status, try again later |
| Empty results | No restaurants match search | Try broader query (e.g., "restaurant" instead of "pizza") |
| Price estimates wrong | Heuristic-based, not real | Upgrade to real nutrition API for production |

## Testing

### Unit Tests
```bash
npm test
```

Tests verify:
- Correct parsing of workflow responses
- Equipment mapping and deduplication
- Confidence value clamping
- Unmapped class filtering
- Request header formatting
- Payload structure

### Integration Testing
Before production deployment:

1. **Test with real Roboflow API**:
   ```typescript
   const provider = new RoboflowEquipmentWorkflowProvider(process.env.ROBOFLOW_API_KEY);
   const result = await provider.detectEquipment(testImage, equipmentLabelMap);
   console.log(result); // Should see real detections
   ```

2. **Test with real Apify API**:
   ```typescript
   const apify = new ApifySwiggyMapsProvider(process.env.APIFY_API_KEY);
   const places = await apify.findNearbyFood({
     latitude: 28.6139,
     longitude: 77.2090,
     query: "restaurant"
   });
   console.log(places); // Should see real restaurants
   ```

## Performance Considerations

### Roboflow Workflow
- **Inference time**: 1-5 seconds (depends on image size and Roboflow load)
- **Request latency**: <100ms to first byte, <1s total
- **Concurrent requests**: Roboflow serverless handles auto-scaling
- **Cost**: Free tier allows reasonable volume; monitor usage

### Apify Swiggy
- **Scraping time**: 15-30 seconds per location/query
- **Polling overhead**: 1 request/second until completion
- **Concurrent limits**: Check Apify account tier for concurrency
- **Cost**: Free tier with usage limits; paid plans available

## Production Checklist

- [ ] Verify Roboflow API key is set and valid
- [ ] Verify Apify API token is set and valid
- [ ] Test equipment detection with representative gym photos
- [ ] Test food search with various locations and cuisines
- [ ] Monitor error rates in production logs
- [ ] Set up alerts for API failures (e.g., 5xx from Roboflow/Apify)
- [ ] Document any custom equipment labels added to mapping
- [ ] Review nutrition estimates for accuracy (consider using real API)
- [ ] Test on slow/unreliable networks for timeout behavior

## Future Enhancements

### Roboflow
- Support batch image processing for multiple equipment detections
- Cache workflow results by image hash to reduce API calls
- Add confidence threshold configuration
- Support video/stream-based detection (WebRTC mode)
- Custom model training on gym-specific photos

### Apify / Food Discovery
- Integrate with FatSecret or USDA FoodData Central for real nutrition data
- Add menu item images from Swiggy
- Support other delivery platforms (Zomato, UberEats, etc.)
- Cache restaurant data by location for faster subsequent queries
- Add dietary preference filtering (vegan, gluten-free, etc.)
- Real-time pricing updates

## References

- [Roboflow Workflows Documentation](https://docs.roboflow.com/workflows/overview)
- [Roboflow Serverless Inference API](https://docs.roboflow.com/api-reference/serverless-api)
- [Apify Documentation](https://docs.apify.com/)
- [Apify JavaScript SDK](https://www.npmjs.com/package/apify-client)
