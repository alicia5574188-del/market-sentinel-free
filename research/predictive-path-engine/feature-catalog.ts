export const PREDICTIVE_FEATURE_CATALOG={
  price:["returns_multi_horizon","slope","acceleration","realized_range","path_efficiency","high_low_geometry","realized_volatility"],
  technical:["ema_family","ema_distance_slope_curvature","macd_components_and_derivatives","rsi_multi_horizon","dmi_adx","cci","williams_r",
    "stoch_rsi","bollinger","keltner","donchian","atr","supertrend","ichimoku","vwap","anchored_vwap","volume_profile"],
  volumeFlow:["volume","relative_volume","cvd","aggressive_buy_sell","ofi","price_impact_per_flow"],
  derivatives:["open_interest","oi_velocity","oi_acceleration","funding","basis","perp_spot_dislocation"],
  liquidation:["observed_liquidation_flow","oi_deleveraging","estimated_liquidation_density","liquidation_distance","cascade_features","post_cascade_continuation"],
  multiVenue:["normalized_returns","price_disagreement","basis_disagreement","oi_disagreement","funding_disagreement","flow_disagreement","cross_venue_agreement"],
  marketContext:["btc_eth_returns","breadth","cross_sectional_correlation","realized_volatility","vol_of_vol","options_iv_optional","options_skew_optional"],
  microstructure:["ofi_5s_15s_30s_1m","microprice","depth_imbalance","add_rate","cancel_rate","consume_rate","spread","depth_gaps"],
} as const;

export type PredictiveFeatureGroup=keyof typeof PREDICTIVE_FEATURE_CATALOG;
