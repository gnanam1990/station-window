-- Keep the history of released reservations while allowing the slot to be reused.
ALTER TABLE quota_reservations
  DROP CONSTRAINT quota_reservations_provider_account_market_address_slot_ind_key;
CREATE UNIQUE INDEX quota_reservations_live_slot
  ON quota_reservations(provider_account, market_address, slot_index)
  WHERE state <> 'released';
