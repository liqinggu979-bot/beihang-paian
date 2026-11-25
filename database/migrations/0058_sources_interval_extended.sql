ALTER TABLE sources ADD CONSTRAINT sources_interval_extended_check CHECK (interval_minutes BETWEEN 1 AND 2880) NOT VALID;
