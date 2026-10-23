-- Platform operations (CLI): the system role may record what operators do. Insert only, and only rows marked source='system'.
CREATE POLICY system_insert ON audit_logs AS PERMISSIVE FOR INSERT TO humantech_system WITH CHECK (source = 'system');
GRANT INSERT ON audit_logs TO humantech_system;
