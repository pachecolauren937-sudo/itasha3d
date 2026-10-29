"""Render corpus1's spatial part assignment as a side-on diagnostic."""
from pathlib import Path
import json
import cv2
import numpy as np
import trimesh

root=Path(__file__).resolve().parents[1]
scene=trimesh.load(root/'assets/taycan_f.glb',force='scene',process=False)
for node in scene.graph.nodes_geometry:
    T,g=scene.graph[node]; mesh=scene.geometry[g]
    if getattr(getattr(mesh.visual,'material',None),'name','')=='corpus1':
        tri=trimesh.transform_points(mesh.vertices,T)[mesh.faces];break
else: raise RuntimeError('corpus1 not found')
mirrortris=[]
for node in scene.graph.nodes_geometry:
    T,g=scene.graph[node]; mesh=scene.geometry[g]
    if getattr(getattr(mesh.visual,'material',None),'name','')=='MIRROR':
        pts=trimesh.transform_points(mesh.vertices,T)[mesh.faces]
        mirrortris.extend(pts[pts.mean(1)[:,0]<0])
colors={'front_bumper':(70,113,242),'front_fender':(75,200,246),'front_door':(232,155,75),'rear_door':(209,107,141),'rear_fender':(131,189,81),'rear_bumper':(118,91,218),'hood':(208,141,241),'roof':(194,191,74),'boot_tailgate':(61,191,177),'side_skirts':(126,111,99),'mirrors':(211,94,32)}
cent=tri.mean(1); z=cent[:,2];y=cent[:,1]
mask=y<.40; label=np.full(len(tri),'front_bumper',dtype=object)
for n,(lo,hi) in [('front_bumper',(1.93,2.49)),('front_fender',(.76,1.93)),('front_door',(-.12,.76)),('rear_door',(-.86,-.12)),('rear_fender',(-1.93,-.86)),('rear_bumper',(-2.5,-1.93))]:
    label[(z>=lo)&(z<hi)&~mask]=n
label[(y>=.76)&(y<1.10)&(z>1.39)]='hood'
label[(y>1.08)&(z> -1.33)&(z<.91)]='roof'
label[(y>=.79)&(y<1.08)&(z< -1.27)]='boot_tailgate'
label[mask&(z>=-1.78)&(z<=1.78)]='side_skirts'
W,H=1600,900; img=np.full((H,W,3),(241,244,247),np.uint8)
def project(p):
    return np.column_stack([((p[:,2]+2.5)/5.0*1260+190).astype(int),((1.43-p[:,1])/1.65*680+115).astype(int)])
# Paint far-side faces first; near-side polygons occlude them, giving the actual shell profile.
order=np.argsort(-cent[:,0])
for i in order:
    pts=project(tri[i]); cv2.fillConvexPoly(img,pts,colors[label[i]],lineType=cv2.LINE_AA)
for p in mirrortris:
    cv2.fillConvexPoly(img,project(p),colors['mirrors'],lineType=cv2.LINE_AA)
cv2.rectangle(img,(0,0),(W-1,H-1),(219,224,232),2)
legend=[('front bumper','front_bumper'),('front fender','front_fender'),('front door','front_door'),('rear door','rear_door'),('rear fender','rear_fender'),('rear bumper','rear_bumper'),('hood','hood'),('roof','roof'),('boot / tailgate','boot_tailgate'),('side skirts','side_skirts'),('mirrors','mirrors')]
cv2.putText(img,'CORPUS1 SPATIAL PANEL MAP  |  LEFT SIDE',(30,43),cv2.FONT_HERSHEY_SIMPLEX,.8,(26,37,52),2,cv2.LINE_AA)
for j,(txt,key) in enumerate(legend):
    x=30+(j//6)*260; yy=100+(j%6)*39
    cv2.rectangle(img,(x,yy-15),(x+22,yy+7),colors[key],-1)
    cv2.putText(img,txt,(x+31,yy+4),cv2.FONT_HERSHEY_SIMPLEX,.52,(26,37,52),1,cv2.LINE_AA)
cv2.imwrite('/tmp/parts_map.png',img)
print('Rendered corpus1 triangles:',len(tri))
