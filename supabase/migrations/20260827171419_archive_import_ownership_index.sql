-- Cover the composite owner/project foreign key for cascade and history reads.
create index imported_project_archives_project_owner_idx on private.imported_project_archives(project_id,user_id);
