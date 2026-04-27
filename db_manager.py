import sqlite3
import json
import os
import threading

class DBManager:
    def __init__(self, db_path):
        self.db_path = db_path
        self.lock = threading.Lock()
        self._init_db()

    def _get_conn(self):
        conn = sqlite3.connect(self.db_path, check_same_thread=False, timeout=30)
        # WAL mode improves performance on slow storage (STB S905W)
        # by reducing disk write operations.
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA synchronous=NORMAL')
        return conn

    def _init_db(self):
        with self.lock:
            conn = self._get_conn()
            cursor = conn.cursor()
            
            # Table for all nodes (server, odps, clients, extra_routers)
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS nodes (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL, -- 'server', 'odp', 'client', 'router'
                    name TEXT NOT NULL,
                    coordinates TEXT, -- Saved as JSON string "[lat, lng]"
                    parent_id TEXT,
                    data TEXT -- All other attributes saved as JSON string
                )
            ''')
            
            # Index for performance
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_type ON nodes(type)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_parent ON nodes(parent_id)')
            
            conn.commit()
            conn.close()

    def save_full_topology(self, topology_dict):
        """
        Saves a full topology dictionary (compatible with topology.json structure).
        Optimized: Incremental save while preserving exact original field mappings.
        """
        if not isinstance(topology_dict, dict): return False
        
        all_incoming_nodes = []
        
        # 1. Server
        s = topology_dict.get('server', {})
        if s: all_incoming_nodes.append((s, 'server'))
            
        # 2. ODPs
        for o in topology_dict.get('odps', []): all_incoming_nodes.append((o, 'odp'))
            
        # 3. Clients
        for c in topology_dict.get('clients', []): all_incoming_nodes.append((c, 'client'))
            
        # 4. Extra Routers
        for r in topology_dict.get('extra_routers', []): all_incoming_nodes.append((r, 'router'))

        if not all_incoming_nodes: return False

        with self.lock:
            conn = self._get_conn()
            cursor = conn.cursor()
            try:
                # Collect all incoming IDs for exclusion-based deletion
                income_ids = [str(n[0].get('id')) for n in all_incoming_nodes if n[0].get('id')]
                
                # Cleanup missing nodes using a temporary table for safety/speed
                cursor.execute('CREATE TEMPORARY TABLE IF NOT EXISTS incoming_ids (id TEXT)')
                cursor.execute('DELETE FROM incoming_ids')
                cursor.executemany('INSERT INTO incoming_ids VALUES (?)', [(i,) for i in income_ids])
                cursor.execute('DELETE FROM nodes WHERE id NOT IN (SELECT id FROM incoming_ids)')
                
                insert_batch = []
                for node, node_type in all_incoming_nodes:
                    nid = str(node.get('id'))
                    if not nid: continue
                    name = str(node.get('name', ''))
                    coords = json.dumps(node.get('coordinates', [0, 0]))
                    
                    # STRICT ORIGINAL MAPPING PRESERVATION:
                    # Original logic for ODP/Router puts EVERYTHING including parent into 'data' (JSON).
                    # Original logic for Client puts 'parent_id' into column AND everything else into 'data'.
                    
                    # Exclusion list matches original code's filter logic per type
                    if node_type == 'client':
                        p_id = node.get('parent_id')
                        # Cast to string or None to match original behavior
                        p_id = str(p_id) if p_id is not None else None
                        
                        data_blob = {k: v for k, v in node.items() if k not in ['id', 'type', 'name', 'coordinates', 'parent_id']}
                        insert_batch.append((nid, node_type, name, coords, p_id, json.dumps(data_blob)))
                    else:
                        # Server, ODP, Router: parent_id column stays NULL/None
                        data_blob = {k: v for k, v in node.items() if k not in ['id', 'type', 'name', 'coordinates']}
                        insert_batch.append((nid, node_type, name, coords, None, json.dumps(data_blob)))

                cursor.executemany(
                    'INSERT OR REPLACE INTO nodes (id, type, name, coordinates, parent_id, data) VALUES (?, ?, ?, ?, ?, ?)',
                    insert_batch
                )
                
                conn.commit()
                return True
            except Exception as e:
                print(f"[DB ERROR] save_full_topology: {e}")
                conn.rollback()
                return False
            finally:
                conn.close()

    def load_full_topology(self):
        """
        Loads all nodes and reconstructs the topology.json structure.
        """
        with self.lock:
            conn = self._get_conn()
            cursor = conn.cursor()
            
            res = {
                "server": {},
                "odps": [],
                "clients": [],
                "extra_routers": []
            }
            
            cursor.execute('SELECT id, type, name, coordinates, parent_id, data FROM nodes')
            rows = cursor.fetchall()
            
            for row in rows:
                node_id, node_type, name, coords_raw, parent_id, data_raw = row
                
                # Parse JSON fields
                try:
                    coords = json.loads(coords_raw) if coords_raw else [0, 0]
                except:
                    coords = [0, 0]
                
                try:
                    data = json.loads(data_raw) if data_raw else {}
                except:
                    data = {}
                
                # Build object
                obj = {"id": node_id, "name": name, "coordinates": coords}
                obj.update(data)
                
                if node_type == 'server':
                    res['server'] = obj
                elif node_type == 'odp':
                    res['odps'].append(obj)
                elif node_type == 'client':
                    obj['parent_id'] = parent_id
                    res['clients'].append(obj)
                elif node_type == 'router':
                    res['extra_routers'].append(obj)
            
            conn.close()
            return res

    def apply_bulk_updates(self, updates):
        """
        Updates multiple nodes efficiently in a single transaction.
        'updates' should be a list of dicts, each with an 'id' and fields to update.
        """
        if not updates: return True
        
        with self.lock:
            conn = self._get_conn()
            cursor = conn.cursor()
            try:
                for upd in updates:
                    node_id = upd.get('id')
                    if not node_id: continue
                    
                    # 1. Get current data
                    cursor.execute('SELECT data FROM nodes WHERE id = ?', (node_id,))
                    row = cursor.fetchone()
                    if not row:
                        # UPSERT: Insert if not exists
                        # We need at least 'type' and 'name' for SQLite NOT NULL constraints
                        # Defaults for safety
                        node_type = upd.get('type', 'client')
                        node_name = upd.get('name', node_id)
                        node_coords = json.dumps(upd.get('coordinates', []))
                        node_parent = upd.get('parent_id', '')
                        
                        # Pack remaining into data
                        new_data = {}
                        for k, v in upd.items():
                            if k not in ['id', 'type', 'name', 'coordinates', 'parent_id']:
                                new_data[k] = v
                        
                        cursor.execute(
                            'INSERT INTO nodes (id, type, name, coordinates, parent_id, data) VALUES (?, ?, ?, ?, ?, ?)',
                            (node_id, node_type, node_name, node_coords, node_parent, json.dumps(new_data))
                        )
                        continue
                    
                    try:
                        data = json.loads(row[0]) if row[0] else {}
                    except:
                        data = {}
                    
                    # 2. Update specific fields
                    changed = False
                    for k, v in upd.items():
                        if k == 'id': continue
                        if k == 'name':
                            cursor.execute('UPDATE nodes SET name = ? WHERE id = ?', (v, node_id))
                        elif k == 'coordinates':
                            cursor.execute('UPDATE nodes SET coordinates = ? WHERE id = ?', (json.dumps(v), node_id))
                        elif k == 'parent_id':
                            cursor.execute('UPDATE nodes SET parent_id = ? WHERE id = ?', (v, node_id))
                        elif k == 'type':
                            cursor.execute('UPDATE nodes SET type = ? WHERE id = ?', (v, node_id))
                        else:
                            if data.get(k) != v:
                                data[k] = v
                                changed = True
                    
                    if changed:
                        cursor.execute('UPDATE nodes SET data = ? WHERE id = ?', (json.dumps(data), node_id))
                
                conn.commit()
                return True
            except Exception as e:
                print(f"[DB ERROR] apply_bulk_updates: {e}")
                conn.rollback()
                return False
            finally:
                conn.close()
