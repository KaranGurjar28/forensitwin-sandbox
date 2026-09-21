import './index.css' 
import { useState, useEffect, Suspense, useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { MapControls, Environment, TransformControls, Html } from '@react-three/drei'
import * as THREE from 'three'
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet' 
import 'leaflet/dist/leaflet.css'

import L from 'leaflet'
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

import { Model as DamagedCar } from './DamagedCar'
import { Model as AltoCar } from './AltoCar'
import { Model as SwiftCar } from './SwiftCar'

// --- MAP RESIZE FIX COMPONENT ---
function MapResizer() {
  const map = useMap();
  useEffect(() => {
    const timeout = setTimeout(() => {
      map.invalidateSize();
    }, 100);
    return () => clearTimeout(timeout);
  }, [map]);
  return null;
}

// --- RESILIENT 3D COMPONENTS ---
function ForensicGround() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]}>
        <planeGeometry args={[3000, 3000]} />
        <meshStandardMaterial color="#e2e8f0" roughness={1} />
      </mesh>
      <gridHelper args={[3000, 3000, '#cbd5e1', '#f8fafc']} position={[0, -0.09, 0]} />
    </group>
  );
}

function RoadMesh({ pts }) {
  const geometry = useMemo(() => {
    try {
      if (pts.length < 2) return null;
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0);
      return new THREE.TubeGeometry(curve, pts.length * 3, 4, 8, false); 
    } catch (e) {
      return null;
    }
  }, [pts]);

  if (!geometry) return null;

  return (
    <mesh scale={[1, 1, 0.02]} geometry={geometry}>
      <meshStandardMaterial color="#334155" roughness={0.9} metalness={0.1} />
    </mesh>
  );
}

function BuildingMesh({ b }) {
  const geometry = useMemo(() => {
    try {
      return new THREE.ExtrudeGeometry(b.shape, { 
        depth: b.height, 
        bevelEnabled: false 
      });
    } catch (e) {
      return null;
    }
  }, [b]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#f8fafc" metalness={0.1} roughness={0.2} envMapIntensity={1.5} />
    </mesh>
  );
}

function EnvironmentData({ lat, lon }) {
  const [data, setData] = useState({ buildings: [], roads: [], trees: [], fences: [], procHouses: [] });
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let isMounted = true;
    
    const fetchEnvironment = async () => {
      setStatus('loading');
      const query = `
        [out:json];
        (
          way["building"](around:300, ${lat}, ${lon});
          way["highway"](around:300, ${lat}, ${lon});
        );
        out geom;
      `;
      
      // ROTATION ARRAY: App will try these servers in order until one answers
      const endpoints = [
        'https://overpass.osm.ch/api/interpreter', // Swiss (Highly reliable)
        'https://overpass.kumi.systems/api/interpreter', // Kumi
        'https://overpass-api.de/api/interpreter', // German Main
        'https://lz4.overpass-api.de/api/interpreter' // German LZ4
      ];

      let json = null;
      let success = false;

      for (const url of endpoints) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(query)}`
          });
          
          if (res.ok) {
            json = await res.json();
            success = true;
            break; // Stop checking servers once we get the data
          }
        } catch (error) {
          console.warn(`Server ${url} failed, trying next...`);
        }
      }

      if (!success || !json) {
        if (isMounted) setStatus('error');
        return;
      }
        
      if (!isMounted) return;

      const genBuildings = [];
      const genRoads = [];
      const genTrees = [];
      const genFences = [];
      const genProcHouses = [];

      json.elements.forEach(el => {
        if (el.type === 'way' && el.tags?.building) {
          if (el.geometry.length < 3) return;
          const shape = new THREE.Shape();
          let valid = true;
          
          el.geometry.forEach((node, index) => {
            const x = (node.lon - lon) * 111320 * Math.cos(lat * (Math.PI / 180));
            const y = (node.lat - lat) * 111320;
            if (isNaN(x) || isNaN(y)) valid = false;
            else if (index === 0) shape.moveTo(x, y);
            else shape.lineTo(x, y);
          });
          
          if (valid) {
            const height = el.tags?.height ? parseFloat(el.tags.height) : 10;
            genBuildings.push({ shape, height });
          }
        }
        else if (el.type === 'way' && el.tags?.highway) {
          const points = [];
          el.geometry.forEach(node => {
            const x = (node.lon - lon) * 111320 * Math.cos(lat * (Math.PI / 180));
            const y = (node.lat - lat) * 111320;
            const newPt = new THREE.Vector3(x, y, 0.05);
            if (points.length === 0 || points[points.length - 1].distanceTo(newPt) > 1.0) {
              points.push(newPt);
            }
          });
          if (points.length > 1) genRoads.push(points);
        }
      });

      const roadCollisionNodes = [];
      genRoads.forEach(pts => {
        try {
          const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0);
          const steps = Math.floor(curve.getLength() / 3); 
          for (let i = 0; i <= steps; i++) {
            roadCollisionNodes.push(curve.getPoint(i / steps));
          }
        } catch (e) {}
      });

      const hasClearance = (x, y, safeRadius) => {
        for (let i = 0; i < roadCollisionNodes.length; i++) {
          const dx = roadCollisionNodes[i].x - x;
          const dy = roadCollisionNodes[i].y - y;
          if (Math.sqrt(dx * dx + dy * dy) < safeRadius) {
            return false; 
          }
        }
        return true; 
      };

      genRoads.forEach(pts => {
        try {
          const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0);
          const roadLength = curve.getLength();
          if (roadLength < 10) return; 
          
          const steps = Math.floor(roadLength / 15); 
          if (steps === 0) return;
          
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const pt = curve.getPoint(t);
            const tangent = curve.getTangent(t);
            const normal = new THREE.Vector3(-tangent.y, tangent.x, 0).normalize();
            const roadRotation = Math.atan2(tangent.y, tangent.x);

            [-1, 1].forEach(side => {
              if (Math.random() > 0.4) {
                const treeX = pt.x + (normal.x * (6 + Math.random() * 2) * side);
                const treeY = pt.y + (normal.y * (6 + Math.random() * 2) * side);
                
                if (hasClearance(treeX, treeY, 5.5)) {
                  genTrees.push({
                    x: treeX, y: treeY, scale: 0.6 + Math.random() * 0.5
                  });
                }
              }

              if (Math.random() > 0.6 && i % 2 === 0) {
                const houseX = pt.x + (normal.x * (18 + Math.random() * 5) * side);
                const houseY = pt.y + (normal.y * (18 + Math.random() * 5) * side);
                
                if (hasClearance(houseX, houseY, 12)) {
                  genProcHouses.push({
                    x: houseX, y: houseY, rotation: roadRotation,
                    w: 8 + Math.random() * 6,
                    d: 10 + Math.random() * 8,
                    h: 6 + Math.random() * 8 
                  });
                }
              }
            });
          }
        } catch (e) {}
      });
      
      setData({ buildings: genBuildings, roads: genRoads, trees: genTrees, fences: genFences, procHouses: genProcHouses });
      setStatus('success');
    };
    
    fetchEnvironment();
    return () => { isMounted = false };
  }, [lat, lon]);

  if (status === 'loading') {
    return (
      <Html center>
        <div className="bg-gray-800 text-white px-4 py-2 md:px-6 md:py-3 rounded-lg shadow-2xl font-bold flex items-center space-x-3 whitespace-nowrap border border-gray-600 text-sm md:text-base">
          <svg className="animate-spin h-5 w-5 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
          <span>Mapping Environment Geometry...</span>
        </div>
      </Html>
    );
  }

  if (status === 'error') {
    return (
      <Html center>
        <div className="bg-red-900 text-white px-4 py-2 md:px-6 md:py-3 rounded-lg shadow-2xl font-bold whitespace-nowrap text-sm md:text-base">
          All Map Servers are busy. Please try moving the pin slightly!
        </div>
      </Html>
    );
  }

  return (
    <group rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
      {data.buildings.map((b, i) => (
        <BuildingMesh key={`bldg-${i}`} b={b} />
      ))}

      {data.procHouses.map((house, i) => (
        <mesh key={`phouse-${i}`} position={[house.x, house.y, house.h / 2]} rotation={[0, 0, house.rotation]}>
          <boxGeometry args={[house.w, house.d, house.h]} />
          <meshStandardMaterial color="#e2e8f0" metalness={0.1} roughness={0.5} envMapIntensity={1.0} />
        </mesh>
      ))}
      
      {data.roads.map((pts, i) => (
        <RoadMesh key={`road-${i}`} pts={pts} />
      ))}

      {data.trees.map((tree, i) => (
        <group key={`tree-${i}`} position={[tree.x, tree.y, 0]} scale={[tree.scale, tree.scale, tree.scale]}>
          <mesh position={[0, 0, 1]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.2, 0.3, 2]} />
            <meshStandardMaterial color="#432818" roughness={1} />
          </mesh>
          <mesh position={[0, 0, 3]} rotation={[Math.PI / 2, 0, 0]}>
            <dodecahedronGeometry args={[2, 1]} />
            <meshStandardMaterial color="#2f855a" roughness={0.8} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// --- 2D MAP COMPONENT ---
function LocationPicker({ lat, lon, setLocation }) {
  useMapEvents({
    click(e) {
      setLocation(e.latlng.lat, e.latlng.lng);
    },
  });
  return <Marker position={[lat, lon]} />;
}

// --- MAIN APPLICATION ---
export default function App() {
  const [viewMode, setViewMode] = useState('2D') 
  const [lat, setLat] = useState(23.0338)
  const [lon, setLon] = useState(72.5065)

  const [activeCar, setActiveCar] = useState('sedan')
  const [crushLevel, setCrushLevel] = useState(0)
  const [controlMode, setControlMode] = useState('translate') 
  const [cameraEnabled, setCameraEnabled] = useState(true)

  return (
    <div className="flex flex-col md:flex-row h-screen bg-gray-900 text-white font-sans overflow-hidden">
      
      <div className="w-full md:w-80 h-[40vh] md:h-full bg-gray-800 flex flex-col shadow-2xl z-10 shrink-0 border-b md:border-b-0 md:border-r border-gray-700">
        <div className="p-4 md:p-6 flex-1 overflow-y-auto">
          <h2 className="text-lg md:text-xl font-bold border-b border-gray-700 pb-3 mb-4 md:pb-4 md:mb-6">ForensiTwin Editor</h2>
          
          <button 
            onClick={() => setViewMode(viewMode === '2D' ? '3D' : '2D')}
            className={`w-full py-2 md:py-3 mb-4 md:mb-6 font-bold text-base md:text-lg rounded shadow-lg transition-colors ${
              viewMode === '2D' ? 'bg-green-600 hover:bg-green-500 text-white' : 'bg-blue-600 hover:bg-blue-500 text-white'
            }`}
          >
            {viewMode === '2D' ? 'Enter 3D Reconstruction ➔' : '⬅ Back to 2D Map'}
          </button>

          <div className="mb-4 md:mb-6 bg-gray-700 p-3 md:p-4 rounded-lg">
            <label className="block text-xs md:text-sm font-semibold text-gray-300 mb-1 md:mb-2">📍 Pinned Coordinates</label>
            <div className="text-xs text-gray-400 font-mono">Lat: {lat.toFixed(6)}</div>
            <div className="text-xs text-gray-400 font-mono">Lon: {lon.toFixed(6)}</div>
          </div>

          {viewMode === '3D' && (
            <div className="space-y-4 md:space-y-6">
              <div>
                <label className="block text-xs md:text-sm font-semibold text-gray-300 mb-1 md:mb-2">Vehicle Model</label>
                <select 
                  value={activeCar} 
                  onChange={(e) => setActiveCar(e.target.value)}
                  className="w-full bg-gray-700 text-white p-2 rounded text-sm md:text-base border border-gray-600 focus:outline-none"
                >
                  <option value="sedan">Generic Sedan</option>
                  <option value="alto">Maruti Alto</option>
                  <option value="swift">Suzuki Swift</option>
                </select>
              </div>

              <div>
                 <label className="block text-xs md:text-sm font-semibold text-gray-300 mb-1 md:mb-2">Kinematic Action</label>
                 <div className="flex space-x-2">
                    <button 
                      onClick={() => setControlMode('translate')} 
                      className={`flex-1 p-2 text-xs md:text-sm font-bold rounded ${controlMode === 'translate' ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
                    >
                      Slide
                    </button>
                    <button 
                      onClick={() => setControlMode('rotate')} 
                      className={`flex-1 p-2 text-xs md:text-sm font-bold rounded ${controlMode === 'rotate' ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
                    >
                      Rotate
                    </button>
                 </div>
              </div>

              <div>
                <label className="block text-xs md:text-sm font-semibold text-gray-300 mb-1 md:mb-2">Frontal Crush Damage</label>
                <input 
                  type="range" min="0" max="1" step="0.01" value={crushLevel} 
                  onChange={(e) => setCrushLevel(parseFloat(e.target.value))}
                  className="w-full accent-blue-500 cursor-pointer"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 relative w-full h-full bg-gray-900">
        {viewMode === '2D' && (
          <MapContainer center={[lat, lon]} zoom={17} className="w-full h-full">
            <MapResizer />
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; OpenStreetMap contributors'
            />
            <LocationPicker lat={lat} lon={lon} setLocation={(newLat, newLon) => {
              setLat(newLat);
              setLon(newLon);
            }} />
          </MapContainer>
        )}

        {viewMode === '3D' && (
          <Canvas camera={{ position: [0, 15, 20], fov: 50 }}>
            <ambientLight intensity={0.7} />
            <directionalLight position={[10, 30, 20]} intensity={1.2} castShadow />
            <Environment preset="city" />
            
            <Suspense fallback={null}>
              <ForensicGround />
              <EnvironmentData lat={lat} lon={lon} />

              <TransformControls 
                mode={controlMode} 
                showY={false}
                onDraggingChanged={(e) => setCameraEnabled(!e.value)}
              >
                  {activeCar === 'sedan' && <DamagedCar damageValue={crushLevel} />}
                  {activeCar === 'alto' && <AltoCar damageValue={crushLevel} />}
                  {activeCar === 'swift' && <SwiftCar damageValue={crushLevel} />}
              </TransformControls>
            </Suspense>

            <MapControls 
              makeDefault 
              enabled={cameraEnabled} 
              maxPolarAngle={Math.PI / 2 - 0.05} 
            />
          </Canvas>
        )}
      </div>
    </div>
  )
}