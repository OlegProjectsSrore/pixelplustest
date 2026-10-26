-- The report preparation now ends in a PDF or, when DeepSeek V4 Pro or the code finds too little information, in a notice.
-- outcome: NULL for reports prepared before this migration, 'report' or 'insufficient'; review_json keeps the verdict and reasons for the team.
-- ADD COLUMN keeps the existing rows and the tables that refer to reports untouched.
ALTER TABLE reports ADD COLUMN outcome TEXT CHECK(outcome IS NULL OR outcome IN ('report','insufficient'));
ALTER TABLE reports ADD COLUMN review_json TEXT;
