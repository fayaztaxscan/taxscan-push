-- Drop the composite (feedUrl, guid) unique constraint and replace it with a
-- single-field unique on guid. Article identity is the GUID alone; multiple
-- section feeds will surface the same article and only the first to claim it
-- should send it.

DROP INDEX "FeedItem_feedUrl_guid_key";
CREATE UNIQUE INDEX "FeedItem_guid_key" ON "FeedItem"("guid");
