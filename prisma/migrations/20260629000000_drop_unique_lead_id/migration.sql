-- Drop the unique constraint on cod_network_lead_id.
-- Multiple orders can share the same lead ID (a lead may generate multiple orders).
DROP INDEX IF EXISTS "orders_cod_network_lead_id_key";
