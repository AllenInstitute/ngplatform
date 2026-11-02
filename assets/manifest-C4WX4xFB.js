const e="registration.panel",t={id:"org.ngplatform.registration",name:"Registration",version:"0.1.0",kind:"tool",enabledByDefault:!1,description:"Aligns a layer to the others from landmark pairs, and reads and writes transform files.",guide:`Registration places a **moving** layer onto the **fixed** space the other layers are in, from pairs of landmarks: the same feature, marked once in each.

## Marking pairs
- Choose the moving layer in the Registration tab.
- Point at a feature in the fixed data and press **Alt+F**; point at the same feature in the moving layer and press **Alt+M**. Pairs match in the order they are marked. (Without a mouse over the views, the views' centre is used.)
- Moving points are kept in the moving layer's own coordinates, so they stay on its features however it is moved.

## Fitting
- **Translation** (1 pair or more), **rigid** (3), **similarity** (3: rigid and one scale) or **affine** (4, not all in a plane). Rigid and similarity never mirror (Horn's quaternion method); affine is least squares. Fits are in millimetres, whatever the voxel sizes.
- With **Live** on, the layer moves with every pair; otherwise **Apply**. **Reset** puts back the transform it had before.
- Each pair's error (the distance, after the fit, between its moving point and its fixed point) and the RMS and largest show how good the fit is; switch a pair off to leave it out. Lines in the views join each moving point to its fixed point.

## Transform files
Import or export the moving layer's placement as moving-to-fixed RAS millimetres: plain 4 × 4 text, ITK / ANTs (\`.txt\`, converted from LPS and from fixed-to-moving) or FreeSurfer LTA (RAS to RAS). Exports are relative to the layer's own placement (as its file gives it), as ngtools writes them.

After the landmark registration of Neuroglancer by Forrest Collman and Sean Martin, and [ngtools](https://github.com/neuroscales/ngtools) by Yaël Balbastre.`,links:[{title:"ngtools (neuroscales)",url:"https://github.com/neuroscales/ngtools"},{title:"Neuroglancer: linear registration example (pull request 883)",url:"https://github.com/google/neuroglancer/pull/883"}],license:"Apache-2.0",activation:[`onView:${e}`,"onCommand:registration.fixedHere","onCommand:registration.movingHere"],contributes:{panels:[{id:e,title:"Registration",slot:"left",order:70}],commands:[{id:"registration.fixedHere",title:"Registration: a fixed landmark at the mouse",group:"Registration"},{id:"registration.movingHere",title:"Registration: a moving landmark at the mouse",group:"Registration"}],keybindings:[{key:"alt+f",command:"registration.fixedHere"},{key:"alt+m",command:"registration.movingHere"}],appState:{key:"registration",version:1}}};export{t as R,e as a};
