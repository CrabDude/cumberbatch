var PairingHeap = (function(){
  function mergeSubheaps(heaps) {
    if (typeof heaps === 'undefined' || heaps.length === 0) {
      return new PairingHeap();
    } else if (heaps.length === 1) {
      return heaps[0];
    } else if (heaps.length === 2) {
      return merge(heaps[0], heaps[1]);
    } else {
      var midPoint = Math.floor(heaps.length / 2);
      return merge(mergeSubheaps(heaps.slice(0, midPoint)), mergeSubheaps(heaps.slice(midPoint)));
    }
  }

  function merge(heap1, heap2) {
    if (!heap1 || typeof heap1.getValue() == 'undefined') return heap2
    else if (!heap2 || typeof heap2.getValue() == 'undefined') return heap1
    else if (heap1.getValue() > heap2.getValue()) {
      return heap2._addSubheap(heap1)
    } else {
      return heap1._addSubheap(heap2)
    }
  }

  function PairingHeap(val, data) {
    this._val = val;
    this._data = data;
    this._parent = undefined;
    this._subheaps = undefined;
  }

  PairingHeap.prototype._addSubheap = function (subheap) {
    if (subheap && typeof subheap._parent !== 'undefined') {
      // remove the subheap from its parent if it's being moved around
      var parent = subheap._parent;
      if (typeof parent._subheaps !== 'undefined') {
        var idx = parent._subheaps.indexOf(subheap);
        if (idx !== -1) {
          parent._subheaps.splice(idx, 1);
        }
      }
    }

    if (typeof this._subheaps === 'undefined') {
      this._subheaps = [subheap];
    } else {
      this._subheaps.push(subheap);
    }
    subheap._parent = this;
    return this;
  };

  PairingHeap.prototype.getValue = function () {
    return this._val;
  };

  PairingHeap.prototype.getData = function () {
    return this._data;
  };

  PairingHeap.prototype.setData = function (data) {
    this._data = data;
    return this;
  };

  PairingHeap.prototype.insert = function (val, data) {
    var newHeap = new PairingHeap(val, data)
    return merge(this, newHeap);
  };

  PairingHeap.prototype.insertHeap = function (val, heap) {
    if (!heap) {
      // insert the heap with
      return merge(this, val);
    } else {
      heap._val = val;
      if (typeof heap._subheaps !== 'undefined' && heap._val < val) {
        // if the heap is changing value and the new value is higher than the old
        // one, we may need to remerge the subheaps
        var subheaps = [this, heap].concat(heap._subheaps);
        delete heap._subheaps;
        return mergeSubheaps(subheaps)
      } else {
        return merge(this, heap);
      }
    }
  };

  PairingHeap.prototype.min = function () {
    return this._val;
  };

  PairingHeap.prototype.removeMin = function () {
    var subheaps = this._subheaps;
    delete this._subheaps;

    var root = mergeSubheaps(subheaps);
    delete root._parent;
    return root;
  };

  return PairingHeap;
})();

module.exports = PairingHeap;
